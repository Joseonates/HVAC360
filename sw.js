/* =====================================================================
   HVAC 360° · Guarda la aplicación en el celular
   ---------------------------------------------------------------------
   Esto es lo que permite instalarla como una app y que abra aunque no
   haya señal. La estrategia es "primero la red": mientras haya internet
   usted siempre ve la versión más nueva, y lo guardado solo entra a
   jugar cuando no hay conexión. Así una actualización nunca se queda
   pegada en el celular.

   Lo que va a Firebase (datos, fotos, firmas) NUNCA pasa por aquí: son
   otros dominios y se dejan ir directo a la red.
   ===================================================================== */
const CACHE = 'hvac360-v2026-10-12';
const BASE = self.registration.scope;
const ESENCIALES = ['', 'index.html', 'tecnico.html', 'cliente.html', 'panel.html',
                    'manifest-oficina.json', 'manifest-tecnico.json', 'manifest-cliente.json',
                    'icon-192.png', 'icon-512.png'].map(p => BASE + p);

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c => Promise.allSettled(ESENCIALES.map(u => c.add(u))))
  );
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const viejos = await caches.keys();
    await Promise.all(viejos.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // Firebase y Google: directo a la red

  e.respondWith((async () => {
    try {
      const r = await fetch(req);
      if (r && r.ok) {
        const c = await caches.open(CACHE);
        c.put(req, r.clone());
      }
      return r;
    } catch (err) {
      const c = await caches.open(CACHE);
      const guardado = await c.match(req);
      if (guardado) return guardado;
      if (req.mode === 'navigate') {
        const inicio = await c.match(BASE + 'index.html');
        if (inicio) return inicio;
      }
      throw err;
    }
  })());
});
