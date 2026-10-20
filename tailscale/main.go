//go:build js

// The playground's Tailscale node (docs/tailscale.md): Tailscale's client
// built to js/wasm, as its own cmd/tsconnect is, run by the apex's shared
// worker (app/src/tailscale/worker.ts). It is one device of the user's
// tailnet for the whole browser, tagged tag:elixir-playground, and gives
// the page connections through it, which leave through the exit node the
// user picked, and the tailnet's connections to it on the ports the page
// listens on. A browser sends no UDP, so everything goes through
// Tailscale's DERP relays over WebSocket.
//
//	globalThis.playgroundTailscale = {
//	  start({ controlURL, hostname, tags, state, save(key, bytes | null), notify(json) }),
//	  login(), logout(), setExitNode(id), setControlURL(url),
//	  dial(host, port, proto, ondata(bytes), onend(error | null))
//	    → Promise<{ write(bytes), end(), close(), local }>,
//	  dnsQuery(bytes) → Promise<bytes>,
//	  listen(port, onconnection(remote) → { ondata, onend, ready(conn) }),
//	  unlisten(port),
//	}
//
// `state` holds what an earlier start saved (key → bytes); notify(json) gets
// status() whenever it changes.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/netip"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall/js"
	"time"

	"golang.org/x/net/dns/dnsmessage"
	"tailscale.com/health"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnauth"
	"tailscale.com/ipn/ipnlocal"
	"tailscale.com/logpolicy"
	"tailscale.com/logtail"
	"tailscale.com/net/netns"
	"tailscale.com/net/tsdial"
	"tailscale.com/tailcfg"
	"tailscale.com/tsd"
	"tailscale.com/types/logger"
	"tailscale.com/wgengine"
	"tailscale.com/wgengine/netstack"
)

var (
	backend *ipnlocal.LocalBackend
	dialer  *tsdial.Dialer
	sys     *tsd.System
	// The page's listeners: port → onconnection.
	listeners sync.Map
	// What the node is asked to be: the control server, its name and tags.
	wanted struct {
		sync.Mutex
		controlURL string
		hostname   string
		tags       []string
	}
	// The last login URL and error the backend sent, and the last status
	// notify() was given.
	reported struct {
		sync.Mutex
		loginURL string
		err      string
		last     string
		notify   js.Value
	}
)

func main() {
	api := js.Global().Get("Object").New()
	api.Set("start", js.FuncOf(start))
	api.Set("login", js.FuncOf(func(js.Value, []js.Value) any {
		return promise(func() (any, error) {
			if err := applyPrefs(); err != nil {
				return nil, err
			}
			return nil, backend.StartLoginInteractive(context.Background())
		})
	}))
	api.Set("logout", js.FuncOf(func(js.Value, []js.Value) any {
		return promise(func() (any, error) {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			err := backend.Logout(ctx, ipnauth.Self)
			reported.Lock()
			reported.loginURL, reported.err = "", ""
			reported.Unlock()
			report()
			return nil, err
		})
	}))
	api.Set("setExitNode", js.FuncOf(func(_ js.Value, args []js.Value) any {
		id := tailcfg.StableNodeID(args[0].String())
		return promise(func() (any, error) {
			_, err := backend.EditPrefs(&ipn.MaskedPrefs{
				Prefs:         ipn.Prefs{ExitNodeID: id},
				ExitNodeIDSet: true,
			})
			report()
			return nil, err
		})
	}))
	api.Set("setControlURL", js.FuncOf(func(_ js.Value, args []js.Value) any {
		url := args[0].String()
		return promise(func() (any, error) {
			wanted.Lock()
			wanted.controlURL = url
			wanted.Unlock()
			err := applyPrefs()
			report()
			return nil, err
		})
	}))
	api.Set("dial", js.FuncOf(dial))
	api.Set("dnsQuery", js.FuncOf(dnsQuery))
	api.Set("listen", js.FuncOf(func(_ js.Value, args []js.Value) any {
		listeners.Store(uint16(args[0].Int()), args[1])
		return nil
	}))
	api.Set("unlisten", js.FuncOf(func(_ js.Value, args []js.Value) any {
		listeners.Delete(uint16(args[0].Int()))
		return nil
	}))
	js.Global().Set("playgroundTailscale", api)
	select {}
}

// The preferences the node always has; a fresh profile (after a logout)
// has Tailscale's defaults until they are applied again.
func prefs() *ipn.Prefs {
	wanted.Lock()
	defer wanted.Unlock()
	p := ipn.NewPrefs()
	p.ControlURL = wanted.controlURL
	p.Hostname = wanted.hostname
	p.AdvertiseTags = wanted.tags
	p.WantRunning = true
	// Subnet routes are not the node's. The tailnet's DNS settings are:
	// its resolver (dnsQuery) answers MagicDNS names, and the rest through
	// the exit node.
	p.RouteAll = false
	p.CorpDNS = true
	return p
}

func applyPrefs() error {
	p := prefs()
	_, err := backend.EditPrefs(&ipn.MaskedPrefs{
		Prefs:            *p,
		ControlURLSet:    true,
		HostnameSet:      true,
		AdvertiseTagsSet: true,
		WantRunningSet:   true,
		RouteAllSet:      true,
		CorpDNSSet:       true,
	})
	return err
}

func start(_ js.Value, args []js.Value) any {
	config := args[0]
	netns.SetEnabled(false)
	wanted.controlURL = config.Get("controlURL").String()
	wanted.hostname = config.Get("hostname").String()
	tags := config.Get("tags")
	for i := 0; i < tags.Length(); i++ {
		wanted.tags = append(wanted.tags, tags.Index(i).String())
	}
	reported.notify = config.Get("notify")

	store := &jsStore{save: config.Get("save"), state: map[ipn.StateKey][]byte{}}
	saved := config.Get("state")
	keys := js.Global().Get("Object").Call("keys", saved)
	for i := 0; i < keys.Length(); i++ {
		key := keys.Index(i).String()
		store.state[ipn.StateKey(key)] = bytesFromJS(saved.Get(key))
	}
	fresh := len(store.state) == 0

	logf := logger.Logf(log.Printf)
	sys = tsd.NewSystem()
	sys.Set(store)
	dialer = &tsdial.Dialer{Logf: logf}
	dialer.SetBus(sys.Bus.Get())
	engine, err := wgengine.NewUserspaceEngine(logf, wgengine.Config{
		Dialer:        dialer,
		SetSubsystem:  sys.Set,
		ControlKnobs:  sys.ControlKnobs(),
		HealthTracker: sys.HealthTracker.Get(),
		ExtraRootCAs:  sys.ExtraRootCAs,
		Metrics:       sys.UserMetricsRegistry(),
		EventBus:      sys.Bus.Get(),
	})
	if err != nil {
		return fail(err)
	}
	sys.Set(engine)
	stack, err := netstack.Create(logf, sys.Tun.Get(), engine, sys.MagicSock.Get(), dialer, sys.DNSManager.Get(), sys.ProxyMapper())
	if err != nil {
		return fail(err)
	}
	sys.Set(stack)
	stack.ProcessLocalIPs = true
	stack.ProcessSubnets = true
	// The tailnet's connections to this device, on the ports the page
	// listens on (listen); the rest are refused.
	stack.GetTCPHandlerForFlow = func(src, dst netip.AddrPort) (func(net.Conn), bool) {
		on, ok := listeners.Load(dst.Port())
		if !ok {
			return nil, false
		}
		return func(conn net.Conn) {
			sink := on.(js.Value).Invoke(src.String())
			sink.Call("ready", pipe(conn, sink.Get("ondata"), sink.Get("onend")))
		}, true
	}
	dialer.UseNetstackForIP = func(netip.Addr) bool { return true }
	dialer.NetstackDialTCP = func(ctx context.Context, dst netip.AddrPort) (net.Conn, error) {
		// Not stack.DialContextTCP's typed nil on an error.
		conn, err := stack.DialContextTCP(ctx, dst)
		if err != nil {
			return nil, err
		}
		return conn, nil
	}
	dialer.NetstackDialUDP = func(ctx context.Context, dst netip.AddrPort) (net.Conn, error) {
		conn, err := stack.DialContextUDP(ctx, dst)
		if err != nil {
			return nil, err
		}
		return conn, nil
	}
	sys.NetstackRouter.Set(true)
	sys.Tun.Get().Start()

	// The log id Tailscale's client keeps; its logs go to the console only.
	policy := logPolicy(store)
	backend, err = ipnlocal.NewLocalBackend(logf, policy.PublicID, sys, 0)
	if err != nil {
		return fail(err)
	}
	if err := stack.Start(backend); err != nil {
		return fail(err)
	}
	backend.SetNotifyCallback(func(n ipn.Notify) {
		reported.Lock()
		if n.BrowseToURL != nil {
			reported.loginURL = *n.BrowseToURL
		}
		if n.ErrMessage != nil {
			reported.err = *n.ErrMessage
		}
		if n.LoginFinished != nil || (n.State != nil && *n.State == ipn.Running) {
			reported.loginURL, reported.err = "", ""
		}
		reported.Unlock()
		// Not from within the backend's callback, which holds its lock.
		go report()
	})
	// Peers come and go without a notification: look again now and then.
	go func() {
		for range time.Tick(3 * time.Second) {
			report()
		}
	}()
	options := ipn.Options{}
	if fresh {
		options.UpdatePrefs = prefs()
	}
	go func() {
		if err := backend.Start(options); err != nil {
			reported.Lock()
			reported.err = err.Error()
			reported.Unlock()
			report()
		}
	}()
	return nil
}

func fail(err error) any {
	log.Printf("tailscale: %v", err)
	reported.Lock()
	reported.err = err.Error()
	reported.Unlock()
	report()
	return nil
}

// What the page shows: the backend's state, a login URL or error while
// it waits for one, this device, and the exit nodes it may use.
type Status struct {
	State          string     `json:"state"`
	LoginURL       string     `json:"loginURL,omitempty"`
	Error          string     `json:"error,omitempty"`
	Warnings       []string   `json:"warnings,omitempty"`
	ControlURL     string     `json:"controlURL"`
	Name           string     `json:"name,omitempty"`
	Addresses      []string   `json:"addresses,omitempty"`
	Tags           []string   `json:"tags,omitempty"`
	Tailnet        string     `json:"tailnet,omitempty"`
	MagicDNSSuffix string     `json:"magicDNSSuffix,omitempty"`
	ExitNode       string     `json:"exitNode,omitempty"`
	ExitNodes      []ExitNode `json:"exitNodes"`
}

type ExitNode struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Online bool   `json:"online"`
}

func status() Status {
	s := Status{State: "NoState", ExitNodes: []ExitNode{}}
	wanted.Lock()
	s.ControlURL = wanted.controlURL
	wanted.Unlock()
	reported.Lock()
	s.LoginURL, s.Error = reported.loginURL, reported.err
	reported.Unlock()
	if backend == nil {
		return s
	}
	st := backend.Status()
	s.State = st.BackendState
	// What Tailscale's own clients would warn of (the control server out
	// of reach, a login that failed), the serious ones, in a stable order.
	if current := backend.HealthTracker().CurrentState(); current != nil {
		for _, warning := range current.Warnings {
			if warning.Severity != health.SeverityLow && warning.Text != "" {
				s.Warnings = append(s.Warnings, warning.Text)
			}
		}
		slices.Sort(s.Warnings)
	}
	if st.CurrentTailnet != nil {
		s.Tailnet = st.CurrentTailnet.Name
		s.MagicDNSSuffix = st.CurrentTailnet.MagicDNSSuffix
	}
	if st.Self != nil && st.BackendState == ipn.Running.String() {
		s.Name = st.Self.DNSName
		for _, ip := range st.TailscaleIPs {
			s.Addresses = append(s.Addresses, ip.String())
		}
		if st.Self.Tags != nil {
			s.Tags = st.Self.Tags.AsSlice()
		}
	}
	for _, peer := range st.Peer {
		if !peer.ExitNodeOption {
			continue
		}
		name := peer.DNSName
		if name == "" {
			name = peer.HostName
		}
		s.ExitNodes = append(s.ExitNodes, ExitNode{ID: string(peer.ID), Name: name, Online: peer.Online})
		if peer.ExitNode {
			s.ExitNode = string(peer.ID)
		}
	}
	if s.ExitNode == "" {
		// Picked, but not (yet) in the netmap.
		s.ExitNode = string(backend.Prefs().ExitNodeID())
	}
	return s
}

// Tell the page the status, if it changed.
func report() {
	data, err := json.Marshal(status())
	if err != nil {
		return
	}
	reported.Lock()
	changed := string(data) != reported.last
	reported.last = string(data)
	notify := reported.notify
	reported.Unlock()
	if changed && notify.Type() == js.TypeFunction {
		notify.Invoke(string(data))
	}
}

// dial(host, port, proto, ondata, onend): a connection through the
// tailnet, to a tailnet name or address, or through the exit node: "tcp",
// or "udp", a connected UDP socket, each write and each ondata one
// datagram. ondata(bytes) gets what arrives and onend(error | null) the
// end, once; the handle's `local` is this device's address and port.
func dial(_ js.Value, args []js.Value) any {
	host, port, proto := args[0].String(), args[1].Int(), args[2].String()
	ondata, onend := args[3], args[4]
	return promise(func() (any, error) {
		if backend == nil {
			return nil, errors.New("Tailscale is not running")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		network := "tcp"
		if proto == "udp" {
			network = "udp"
		}
		conn, err := dialer.UserDial(ctx, network, net.JoinHostPort(host, strconv.Itoa(port)))
		if err != nil {
			return nil, err
		}
		return pipe(conn, ondata, onend), nil
	})
}

// dnsQuery(bytes): a DNS message answered as Tailscale's own resolver
// (100.100.100.100) answers it: MagicDNS names from the netmap, the rest
// through the exit node's DNS, or the tailnet's resolvers. A name of one
// label is the tailnet's (my-laptop: my-laptop.TAILNET.ts.net), as the
// tailnet's search domain makes it on a system.
func dnsQuery(_ js.Value, args []js.Value) any {
	query := bytesFromJS(args[0])
	return promise(func() (any, error) {
		if sys == nil {
			return nil, errors.New("Tailscale is not running")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		resolve := func(q []byte) ([]byte, error) {
			return sys.DNSManager.Get().Query(ctx, q, "udp", netip.MustParseAddrPort("127.0.0.1:53"))
		}
		answer, err := resolveShort(query, resolve)
		if err != nil {
			answer, err = resolve(query)
		}
		if err != nil {
			return nil, err
		}
		out := js.Global().Get("Uint8Array").New(len(answer))
		js.CopyBytesToJS(out, answer)
		return out, nil
	})
}

// A query for a name of one label, asked as the tailnet's (NAME.SUFFIX.)
// and answered under the name it asked; an error for any other query.
func resolveShort(query []byte, resolve func([]byte) ([]byte, error)) ([]byte, error) {
	var msg dnsmessage.Message
	if err := msg.Unpack(query); err != nil || len(msg.Questions) != 1 {
		return nil, errors.New("not one question")
	}
	short := msg.Questions[0].Name
	if strings.Count(short.String(), ".") != 1 || short.String() == "." {
		return nil, errors.New("not one label")
	}
	nm := backend.NetMap()
	if nm == nil || nm.MagicDNSSuffix() == "" {
		return nil, errors.New("no MagicDNS")
	}
	full, err := dnsmessage.NewName(short.String() + nm.MagicDNSSuffix() + ".")
	if err != nil {
		return nil, err
	}
	msg.Questions[0].Name = full
	asked, err := msg.Pack()
	if err != nil {
		return nil, err
	}
	bytes, err := resolve(asked)
	if err != nil {
		return nil, err
	}
	var answer dnsmessage.Message
	if err := answer.Unpack(bytes); err != nil {
		return nil, err
	}
	for i := range answer.Questions {
		if strings.EqualFold(answer.Questions[i].Name.String(), full.String()) {
			answer.Questions[i].Name = short
		}
	}
	for i := range answer.Answers {
		if strings.EqualFold(answer.Answers[i].Header.Name.String(), full.String()) {
			answer.Answers[i].Header.Name = short
		}
	}
	return answer.Pack()
}

// The page's side of a connection: writes go out in order, from a
// goroutine (a js.Func must not block on the network, which needs the
// event loop it holds).
func pipe(conn net.Conn, ondata, onend js.Value) js.Value {
	var (
		mu      sync.Mutex
		queue   [][]byte
		ending  bool
		closed  bool
		wake    = make(chan struct{}, 1)
		endOnce sync.Once
	)
	finish := func(err error) {
		endOnce.Do(func() {
			if err == nil || errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
				onend.Invoke(js.Null())
			} else {
				onend.Invoke(err.Error())
			}
		})
	}
	signal := func() {
		select {
		case wake <- struct{}{}:
		default:
		}
	}
	go func() {
		for range wake {
			mu.Lock()
			batch, end, done := queue, ending, closed
			queue = nil
			mu.Unlock()
			for _, bytes := range batch {
				if _, err := conn.Write(bytes); err != nil {
					conn.Close()
					return
				}
			}
			if done {
				return
			}
			if end {
				if half, ok := conn.(interface{ CloseWrite() error }); ok {
					half.CloseWrite()
				}
				return
			}
		}
	}()
	go func() {
		buffer := make([]byte, 64<<10)
		for {
			n, err := conn.Read(buffer)
			if n > 0 {
				chunk := js.Global().Get("Uint8Array").New(n)
				js.CopyBytesToJS(chunk, buffer[:n])
				ondata.Invoke(chunk)
			}
			if err != nil {
				finish(err)
				return
			}
		}
	}()
	handle := js.Global().Get("Object").New()
	handle.Set("local", conn.LocalAddr().String())
	handle.Set("write", js.FuncOf(func(_ js.Value, args []js.Value) any {
		mu.Lock()
		queue = append(queue, bytesFromJS(args[0]))
		mu.Unlock()
		signal()
		return nil
	}))
	handle.Set("end", js.FuncOf(func(js.Value, []js.Value) any {
		mu.Lock()
		ending = true
		mu.Unlock()
		signal()
		return nil
	}))
	handle.Set("close", js.FuncOf(func(js.Value, []js.Value) any {
		mu.Lock()
		closed = true
		mu.Unlock()
		signal()
		conn.Close()
		return nil
	}))
	return handle
}

// A Promise for what fn returns, run on a goroutine of its own.
func promise(fn func() (any, error)) js.Value {
	return js.Global().Get("Promise").New(js.FuncOf(func(_ js.Value, args []js.Value) any {
		resolve, reject := args[0], args[1]
		go func() {
			value, err := fn()
			if err != nil {
				reject.Invoke(js.Global().Get("Error").New(err.Error()))
			} else {
				resolve.Invoke(value)
			}
		}()
		return nil
	}))
}

func bytesFromJS(value js.Value) []byte {
	out := make([]byte, value.Get("length").Int())
	js.CopyBytesToGo(out, value)
	return out
}

// The node's state, kept by the page (IndexedDB on the apex): read from
// what start() was given, each write handed to save(key, bytes | null).
type jsStore struct {
	mu    sync.Mutex
	state map[ipn.StateKey][]byte
	save  js.Value
}

func (s *jsStore) ReadState(id ipn.StateKey) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	bytes, ok := s.state[id]
	if !ok {
		return nil, ipn.ErrStateNotExist
	}
	return bytes, nil
}

func (s *jsStore) WriteState(id ipn.StateKey, bytes []byte) error {
	s.mu.Lock()
	if bytes == nil {
		delete(s.state, id)
	} else {
		s.state[id] = append([]byte(nil), bytes...)
	}
	s.mu.Unlock()
	if bytes == nil {
		s.save.Invoke(string(id), js.Null())
	} else {
		chunk := js.Global().Get("Uint8Array").New(len(bytes))
		js.CopyBytesToJS(chunk, bytes)
		s.save.Invoke(string(id), chunk)
	}
	return nil
}

// As cmd/tsconnect keeps it: the log id, made once and kept in the store.
const logPolicyKey = ipn.StateKey("log-policy")

func logPolicy(store ipn.StateStore) *logpolicy.Config {
	if bytes, err := store.ReadState(logPolicyKey); err == nil {
		if config, err := logpolicy.ConfigFromBytes(bytes); err == nil {
			return config
		}
	}
	config := logpolicy.NewConfig(logtail.CollectionNode)
	store.WriteState(logPolicyKey, config.ToBytes())
	return config
}
