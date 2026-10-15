// Shows the notifications Playground.Notifications.WebPush sends (after
// SCA's). Every push must show one: browsers revoke a subscription that
// receives silent pushes.

self.addEventListener("push", (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch (_error) {
    data = {body: event.data.text()}
  }

  const options = {body: data.body || "", data: {url: data.url || "/admin/"}}

  if (data.tag) {
    options.tag = data.tag
    options.renotify = true
  }

  event.waitUntil(self.registration.showNotification(data.title || "Playground", options))
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const url = new URL(event.notification.data.url, self.location.origin).href

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type: "window", includeUncontrolled: true})
    const open = windows.find((client) => client.url === url) || windows[0]

    if (open) {
      await open.focus()
      if (open.url !== url && "navigate" in open) await open.navigate(url)
    } else {
      await self.clients.openWindow(url)
    }
  })())
})
