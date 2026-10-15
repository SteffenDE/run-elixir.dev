// Command sandbox-netd is the only network peer of a sandbox VM.
//
// The guest's sandbox-vsock connects to the socket given by -vm (Firecracker
// passes the guest's vsock connection on to it) and exchanges the guest's
// Ethernet frames with a userspace TCP/IP stack. Every TCP connection
// the guest opens, to any address, is accepted and handed to the socket given
// by -proxy, introduced by a line naming its destination:
//
//	SANDBOX_CONNECT <host> <port> <tls|plain> <server name>
//
// The server name is what a TLS client asked for in its ClientHello, or "-".
//
// DNS is answered from a private range, remembering which name got which
// address, so that a connection is named by what the guest looked up. Nothing
// else leaves the VM, and whatever listens on -proxy decides what a connection
// may do.
//
// What never becomes a connection is reported to the same socket, one line per
// connection, and each distinct event only once:
//
//	SANDBOX_EVENT dns <name>
//	SANDBOX_EVENT blocked udp <host> <port>
//
// The process exits when its stdin closes, so it doesn't outlive its host.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"gvisor.dev/gvisor/pkg/buffer"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/link/channel"
	"gvisor.dev/gvisor/pkg/tcpip/link/ethernet"
	"gvisor.dev/gvisor/pkg/tcpip/network/arp"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
	"gvisor.dev/gvisor/pkg/tcpip/transport/udp"
	"gvisor.dev/gvisor/pkg/waiter"

	"github.com/miekg/dns"
)

const (
	nicID = 1
	mtu   = 1500

	// The guest is configured statically, so there is no DHCP.
	gatewayAddr = "10.0.2.2"
	gatewayMAC  = "\x52\x54\x00\x12\x34\x57"

	// Names resolve into 10.99.0.0/16, outside the guest's subnet, so that the
	// guest routes to the gateway instead of looking for the address itself.
	fakeBase = "10.99.0.0"
	maxNames = 65534

	// Bounds what the guest can make this process remember and report.
	maxEvents = 4096

	maxFrame = 65536

	// A TLS record carries at most 2^14 bytes, and a ClientHello fits in one.
	// In Elixir this would be 5 + 2**14.
	maxRecord = 5 + 1<<14

	// How long a connection's first bytes are waited for, which delays protocols
	// where the server speaks first (SMTP, etc.), but those are not relevant for us.
	peekTimeout = 2 * time.Second
)

func main() {
	vmPath := flag.String("vm", "", "unix socket the guest's frames arrive on")
	proxyPath := flag.String("proxy", "", "unix socket that accepted connections are handed to")
	flag.Parse()

	if *vmPath == "" || *proxyPath == "" {
		fmt.Fprintln(os.Stderr, "usage: sandbox-netd -vm <socket> -proxy <socket>")
		os.Exit(2)
	}

	log.SetPrefix("sandbox-netd: ")
	log.SetFlags(0)

	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		os.Exit(0)
	}()

	if err := run(*vmPath, *proxyPath); err != nil {
		log.Fatal(err)
	}
}

func run(vmPath, proxyPath string) error {
	_ = os.Remove(vmPath)

	listener, err := net.Listen("unix", vmPath)
	if err != nil {
		return fmt.Errorf("listen %s: %w", vmPath, err)
	}
	defer listener.Close()

	// The VM connects to this socket, so it can only be started once it exists.
	fmt.Println("SANDBOX_NETD_READY")

	// One sidecar serves one VM, so the first connection is the only one.
	conn, err := listener.Accept()
	if err != nil {
		return fmt.Errorf("accept: %w", err)
	}
	defer conn.Close()
	listener.Close()

	names := newResolver()
	events := newReporter(proxyPath)
	link := channel.New(1024, mtu, tcpip.LinkAddress(gatewayMAC))

	s, err := newStack(ethernet.New(link))
	if err != nil {
		return err
	}
	defer s.Close()

	s.SetTransportProtocolHandler(tcp.ProtocolNumber, tcpHandler(s, names, proxyPath))
	s.SetTransportProtocolHandler(udp.ProtocolNumber, udpHandler(s, names, events))

	go writeFrames(conn, link)

	return readFrames(conn, link)
}

func newStack(ep stack.LinkEndpoint) (*stack.Stack, error) {
	s := stack.New(stack.Options{
		NetworkProtocols:   []stack.NetworkProtocolFactory{ipv4.NewProtocol, arp.NewProtocol},
		TransportProtocols: []stack.TransportProtocolFactory{tcp.NewProtocol, udp.NewProtocol},
	})

	if err := s.CreateNIC(nicID, ep); err != nil {
		return nil, fmt.Errorf("create nic: %v", err)
	}

	gateway := netip.MustParseAddr(gatewayAddr)

	protoAddr := tcpip.ProtocolAddress{
		Protocol:          ipv4.ProtocolNumber,
		AddressWithPrefix: tcpip.AddrFrom4(gateway.As4()).WithPrefix(),
	}

	if err := s.AddProtocolAddress(nicID, protoAddr, stack.AddressProperties{}); err != nil {
		return nil, fmt.Errorf("add address: %v", err)
	}

	// Promiscuous mode accepts packets for any address and spoofing allows
	// answering from any address, which is what lets the guest connect anywhere.
	s.SetPromiscuousMode(nicID, true)
	s.SetSpoofing(nicID, true)
	s.SetRouteTable([]tcpip.Route{{Destination: header.IPv4EmptySubnet, NIC: nicID}})

	return s, nil
}

// readFrames moves guest frames into the stack. sandbox-vsock, like QEMU's stream netdev, prefixes
// each frame with its length as a big-endian uint32.
func readFrames(conn net.Conn, link *channel.Endpoint) error {
	reader := bufio.NewReaderSize(conn, maxFrame)
	var length [4]byte

	for {
		if _, err := io.ReadFull(reader, length[:]); err != nil {
			if err == io.EOF {
				return nil
			}
			return fmt.Errorf("read frame length: %w", err)
		}

		size := binary.BigEndian.Uint32(length[:])
		if size == 0 || size > maxFrame {
			return fmt.Errorf("frame length %d out of range", size)
		}

		frame := make([]byte, size)
		if _, err := io.ReadFull(reader, frame); err != nil {
			return fmt.Errorf("read frame: %w", err)
		}

		packet := stack.NewPacketBuffer(stack.PacketBufferOptions{
			Payload: buffer.MakeWithData(frame),
		})
		link.InjectInbound(header.EthernetProtocolAll, packet)
		packet.DecRef()
	}
}

// writeFrames moves frames from the stack back to the guest.
func writeFrames(conn net.Conn, link *channel.Endpoint) {
	for {
		packet := link.ReadContext(context.Background())
		if packet == nil {
			return
		}

		frame := packet.ToView().AsSlice()
		out := make([]byte, 4+len(frame))
		binary.BigEndian.PutUint32(out[:4], uint32(len(frame)))
		copy(out[4:], frame)
		packet.DecRef()

		if _, err := conn.Write(out); err != nil {
			return
		}
	}
}

func tcpHandler(s *stack.Stack, names *resolver, proxyPath string) func(stack.TransportEndpointID, *stack.PacketBuffer) bool {
	forwarder := tcp.NewForwarder(s, 0, 512, func(request *tcp.ForwarderRequest) {
		id := request.ID()

		var wq waiter.Queue
		endpoint, err := request.CreateEndpoint(&wq)
		if err != nil {
			request.Complete(true)
			return
		}
		request.Complete(false)

		host := names.name(addrOf(id.LocalAddress))
		port := strconv.Itoa(int(id.LocalPort))

		go proxy(gonet.NewTCPConn(&wq, endpoint), proxyPath, host, port)
	})

	return forwarder.HandlePacket
}

// proxy hands one guest connection to the proxy socket. After the header, the
// bytes are the guest's, verbatim, in both directions.
func proxy(guest *gonet.TCPConn, proxyPath, host, port string) {
	defer guest.Close()

	// Peeking doesn't consume, so reading from the buffer still starts at the
	// guest's first byte.
	buffered := bufio.NewReaderSize(guest, maxRecord)
	protocol, serverName := classify(guest, buffered)

	conn, err := net.Dial("unix", proxyPath)
	if err != nil {
		log.Printf("dial proxy: %v", err)
		return
	}
	upstream := conn.(*net.UnixConn)
	defer upstream.Close()

	header := fmt.Sprintf("SANDBOX_CONNECT %s %s %s %s\n", safe(host), port, protocol, safe(serverName))
	if _, err := io.WriteString(upstream, header); err != nil {
		log.Printf("write header: %v", err)
		return
	}

	done := make(chan struct{}, 2)

	go func() {
		_, _ = io.Copy(upstream, buffered)
		_ = upstream.CloseWrite()
		done <- struct{}{}
	}()

	go func() {
		_, _ = io.Copy(guest, upstream)
		_ = guest.CloseWrite()
		done <- struct{}{}
	}()

	<-done
	<-done
}

// classify tells TLS apart by the handshake record it starts with, and reads the
// server name from the ClientHello in it. Anything that doesn't start like TLS
// within peekTimeout is plain.
func classify(guest *gonet.TCPConn, buffered *bufio.Reader) (protocol, serverName string) {
	_ = guest.SetReadDeadline(time.Now().Add(peekTimeout))
	defer func() { _ = guest.SetReadDeadline(time.Time{}) }()

	header, err := buffered.Peek(5)
	if err != nil || header[0] != 0x16 || header[1] != 0x03 {
		return "plain", ""
	}

	record, err := buffered.Peek(5 + int(binary.BigEndian.Uint16(header[3:5])))
	if err != nil {
		return "tls", ""
	}

	return "tls", helloServerName(record)
}

var errHelloRead = errors.New("hello read")

// helloServerName lets crypto/tls parse the ClientHello, and ends the handshake
// as soon as it has.
func helloServerName(record []byte) string {
	var name string

	config := &tls.Config{
		GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
			name = hello.ServerName
			return nil, errHelloRead
		},
	}

	_ = tls.Server(&helloConn{reader: bytes.NewReader(record)}, config).Handshake()

	return name
}

// helloConn replays a ClientHello to crypto/tls and discards the alert it sends
// back. The handshake doesn't use any other part of the connection.
type helloConn struct {
	net.Conn
	reader io.Reader
}

func (c *helloConn) Read(p []byte) (int, error)  { return c.reader.Read(p) }
func (c *helloConn) Write(p []byte) (int, error) { return len(p), nil }

// safe keeps names the guest chose out of the structure of header lines, which
// are space separated and newline terminated.
func safe(name string) string {
	if name == "" || len(name) > 253 {
		return "-"
	}

	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '.' || r == '-' || r == '_' || r == ':':
		default:
			return "-"
		}
	}

	return name
}

func udpHandler(s *stack.Stack, names *resolver, events *reporter) func(stack.TransportEndpointID, *stack.PacketBuffer) bool {
	forwarder := udp.NewForwarder(s, func(request *udp.ForwarderRequest) bool {
		id := request.ID()

		// DNS is the only UDP the guest gets an answer for.
		if id.LocalPort != 53 {
			host := names.name(addrOf(id.LocalAddress))
			events.report("blocked", "udp", host, strconv.Itoa(int(id.LocalPort)))
			return false
		}

		var wq waiter.Queue
		endpoint, err := request.CreateEndpoint(&wq)
		if err != nil {
			return false
		}

		go serveDNS(gonet.NewUDPConn(&wq, endpoint), names, events)

		return true
	})

	return forwarder.HandlePacket
}

func serveDNS(conn *gonet.UDPConn, names *resolver, events *reporter) {
	defer conn.Close()

	query := make([]byte, 512)
	n, addr, err := conn.ReadFrom(query)
	if err != nil {
		return
	}

	request := new(dns.Msg)
	if err := request.Unpack(query[:n]); err != nil || len(request.Question) == 0 {
		return
	}

	reply := new(dns.Msg)
	reply.SetReply(request)

	question := request.Question[0]
	name := strings.ToLower(strings.TrimSuffix(question.Name, "."))
	events.report("dns", name)

	// Only A records get an address. AAAA is answered empty rather than refused,
	// so that the guest falls back to IPv4 instead of waiting for a timeout.
	if question.Qtype == dns.TypeA && question.Qclass == dns.ClassINET {
		if address, ok := names.assign(name); ok {
			reply.Answer = append(reply.Answer, &dns.A{
				Hdr: dns.RR_Header{
					Name:   question.Name,
					Rrtype: dns.TypeA,
					Class:  dns.ClassINET,
					Ttl:    1,
				},
				A: net.IP(address.AsSlice()),
			})
		} else {
			reply.Rcode = dns.RcodeServerFailure
		}
	}

	packed, err := reply.Pack()
	if err != nil {
		return
	}

	_, _ = conn.WriteTo(packed, addr)
}

// resolver hands out an address per name and remembers which was which.
type resolver struct {
	mu     sync.Mutex
	next   uint32
	byName map[string]netip.Addr
	byAddr map[netip.Addr]string
}

func newResolver() *resolver {
	base := netip.MustParseAddr(fakeBase).As4()

	return &resolver{
		next:   binary.BigEndian.Uint32(base[:]),
		byName: make(map[string]netip.Addr),
		byAddr: make(map[netip.Addr]string),
	}
}

// assign returns the address for a name, or false once the range is used up.
func (r *resolver) assign(name string) (netip.Addr, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if addr, ok := r.byName[name]; ok {
		return addr, true
	}

	if len(r.byName) >= maxNames {
		return netip.Addr{}, false
	}

	r.next++

	var raw [4]byte
	binary.BigEndian.PutUint32(raw[:], r.next)
	addr := netip.AddrFrom4(raw)

	r.byName[name] = addr
	r.byAddr[addr] = name

	return addr, true
}

// name returns the name an address was handed out for, or the address itself
// when the guest connected to one it never looked up.
func (r *resolver) name(addr netip.Addr) string {
	r.mu.Lock()
	defer r.mu.Unlock()

	if name, ok := r.byAddr[addr]; ok {
		return name
	}

	return addr.String()
}

// reporter sends events to the proxy socket, each distinct one once.
type reporter struct {
	path string
	mu   sync.Mutex
	seen map[string]bool
}

func newReporter(path string) *reporter {
	return &reporter{path: path, seen: make(map[string]bool)}
}

// report doesn't wait for the event to be sent, as it's called while the stack
// handles a packet.
func (r *reporter) report(kind string, fields ...string) {
	line := "SANDBOX_EVENT " + kind
	for _, field := range fields {
		line += " " + safe(field)
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if r.seen[line] || len(r.seen) >= maxEvents {
		return
	}
	r.seen[line] = true

	go r.send(line)
}

func (r *reporter) send(line string) {
	conn, err := net.Dial("unix", r.path)
	if err != nil {
		log.Printf("dial proxy: %v", err)
		return
	}
	defer conn.Close()

	if _, err := io.WriteString(conn, line+"\n"); err != nil {
		log.Printf("write event: %v", err)
	}
}

func addrOf(address tcpip.Address) netip.Addr {
	addr, _ := netip.AddrFromSlice(address.AsSlice())
	return addr
}
