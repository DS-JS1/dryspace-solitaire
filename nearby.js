/* Play Nearby — connect phones directly so each player uses their own device.
   Two ways to find each other:
   - Room code: PeerJS's free public broker introduces the phones (internet needed only to connect).
   - No internet: the phones swap connection details by scanning QR codes (or AirDrop/paste),
     then talk over the shared Wi-Fi. Nothing goes through a server.
   Once connected, game messages go phone-to-phone. Shared across the games; each game passes a cfg. */
'use strict';
const Nearby = (() => {
  const VENDOR = { peer: 'vendor/peerjs.min.js', qr: 'vendor/qrcode.js', scan: 'vendor/jsQR.js' };
  const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const PEER_OPTS = { debug: 0, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }] } };
  let cfg = null, role = null, links = [], peer = null, roomCode = null, hostQR = null, joinQR = null, screen = 'main', tab = 'code';
  let prefs = {};

  /* ---------- a connection to one other phone ---------- */
  class Link {
    constructor(kind) { this.kind = kind; this.h = {}; this.open = false; this.dead = false; this.lastSeen = Date.now(); }
    on(e, f) { (this.h[e] || (this.h[e] = [])).push(f); return this; }
    emit(e, d) { (this.h[e] || []).forEach(f => { try { f(d); } catch (err) { console.error(err); } }); }
    send(obj) { if (!this.open) return; try { this._send(JSON.stringify(obj)); } catch {} }
    _recv(txt) {
      this.lastSeen = Date.now();
      let m; try { m = JSON.parse(typeof txt === 'string' ? txt : new TextDecoder().decode(txt)); } catch { return; }
      if (m && m.t !== 'ping') this.emit('message', m);
    }
    _opened() {
      if (this.open || this.dead) return;
      this.open = true; this.lastSeen = Date.now();
      // heartbeat: a locked phone or dropped Wi-Fi shows up as silence
      this.hb = setInterval(() => { this.send({ t: 'ping' }); if (Date.now() - this.lastSeen > 12000) this._closed(); }, 3000);
      this.emit('open');
    }
    _closed() {
      if (this.dead) return;
      this.dead = true; this.open = false; clearInterval(this.hb);
      links = links.filter(l => l !== this);
      this.emit('close');
    }
    close() { try { this._close && this._close(); } catch {} this._closed(); }
  }
  function fromPeerConn(conn) {
    const L = new Link('code');
    L._send = s => conn.send(s); L._close = () => conn.close();
    conn.on('data', d => L._recv(d)); conn.on('close', () => L._closed()); conn.on('error', () => L._closed());
    if (conn.open) setTimeout(() => L._opened()); else conn.on('open', () => L._opened());
    return L;
  }
  function fromChannel(pc, ch) {
    const L = new Link('qr');
    L._send = s => ch.send(s); L._close = () => { try { ch.close(); } catch {} pc.close(); };
    ch.onmessage = e => L._recv(e.data); ch.onclose = () => L._closed();
    pc.addEventListener('connectionstatechange', () => { if (['failed', 'closed'].includes(pc.connectionState)) L._closed(); });
    if (ch.readyState === 'open') setTimeout(() => L._opened()); else ch.onopen = () => L._opened();
    return L;
  }
  function adopt(L, r) {
    role = r; links.push(L);
    L.on('close', () => { if (screen !== 'closed') rerender(); });
    cfg.onLink(L, r);
    L.on('open', () => rerender());
    if (L.open) setTimeout(() => L.emit('open'));      // already open (room-code join): let the game see it
  }

  /* ---------- helpers ---------- */
  const loaded = {};
  function lib(src) {
    return loaded[src] || (loaded[src] = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = src; s.onload = res;
      s.onerror = () => { delete loaded[src]; rej(new Error('Couldn’t load ' + src)); };
      document.head.appendChild(s);
    }));
  }
  const rnd = n => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
  const b64 = u => btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  async function squeeze(bytes, back) {
    const S = back ? window.DecompressionStream : window.CompressionStream;
    const st = new Blob([bytes]).stream().pipeThrough(new S('deflate-raw'));
    return new Uint8Array(await new Response(st).arrayBuffer());
  }
  // connection details -> short text for a QR code: "DSG1:<game>:<base64>"
  // drop SDP lines a data-only, same-Wi-Fi connection doesn't need, so the QR code has fewer dots
  const trim = sdp => sdp.split(/\r?\n/).filter(l => l && !/^a=(extmap-allow-mixed|msid-semantic)/.test(l) && !(/^a=candidate/.test(l) && / tcp /i.test(l))).join('\r\n') + '\r\n';
  async function pack(desc) {
    let bytes = new TextEncoder().encode(JSON.stringify({ t: desc.type[0], s: trim(desc.sdp) })), z = '0';
    try { if (window.CompressionStream) { bytes = await squeeze(bytes, false); z = '1'; } } catch {}
    return `DSG${z}:${cfg.game}:${b64(bytes)}`;
  }
  async function unpack(str) {
    const m = /^DSG([01]):([a-z0-9]+):([A-Za-z0-9_-]+)$/.exec(String(str).trim());
    if (!m) throw new Error('That isn’t a game code');
    if (m[2] !== cfg.game) throw new Error('That code is for a different game');
    let bytes = unb64(m[3]); if (m[1] === '1') bytes = await squeeze(bytes, true);
    const o = JSON.parse(new TextDecoder().decode(bytes));
    return { type: o.t === 'o' ? 'offer' : 'answer', sdp: o.s };
  }
  function gathered(pc) {
    return new Promise(res => {
      if (pc.iceGatheringState === 'complete') return res();
      const t = setTimeout(res, 3500);
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
    });
  }
  function drawQR(canvas, text) {
    const q = qrcode(0, 'L'); q.addData(text, 'Byte'); q.make();
    const n = q.getModuleCount(), quiet = 3, sc = Math.max(3, Math.floor(560 / (n + quiet * 2))), size = (n + quiet * 2) * sc;
    canvas.width = canvas.height = size;
    const x = canvas.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, size, size); x.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) x.fillRect((c + quiet) * sc, (r + quiet) * sc, sc, sc);
  }
  async function shareText(text) {
    try { if (navigator.share) { await navigator.share({ text }); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(text); cfg.toast('Code copied — paste it on the other phone'); } catch { cfg.toast('Couldn’t copy — use the QR code instead'); }
  }
  function scanQR() {
    return new Promise(res => {
      const m = cfg.openModal(`<h2>Scan the code</h2><div class="nb-cam"><video playsinline muted autoplay></video></div>
        <div class="note" style="text-align:center">Point at the QR code on the other phone</div>
        <button class="btn ghost" data-nb="cancel">Cancel</button>`, true);
      const v = m.querySelector('video'); let stream = null, stop = false;
      const end = val => { if (stop) return; stop = true; if (stream) stream.getTracks().forEach(t => t.stop()); res(val); };
      m.addEventListener('click', e => { if (e.target.dataset.nb === 'cancel' || e.target === m) end(null); });
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { cfg.toast('No camera here — use Paste instead'); return end(null); }
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }).then(s => {
        stream = s; v.srcObject = s; v.play().catch(() => {});
        const c = document.createElement('canvas'), x = c.getContext('2d', { willReadFrequently: true });
        const tick = () => {
          if (stop) return;
          if (v.readyState >= 2 && v.videoWidth) {
            const k = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight));
            c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
            x.drawImage(v, 0, 0, c.width, c.height);
            const r = jsQR(x.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: 'dontInvert' });
            if (r && r.data && r.data.startsWith('DSG')) return end(r.data);
          }
          setTimeout(tick, 140);
        };
        tick();
      }).catch(() => { cfg.toast('Camera blocked — allow it in Settings, or use Paste'); end(null); });
    });
  }

  /* ---------- hosting ---------- */
  function hostWithCode() {
    if (peer && roomCode) return Promise.resolve(roomCode);
    return lib(VENDOR.peer).then(() => new Promise((res, rej) => {
      const attempt = n => {
        const code = Array.from({ length: 4 }, () => ALPHA[rnd(ALPHA.length)]).join('');
        const p = new Peer(`dsgames-${cfg.game}-${code}`, PEER_OPTS); let ok = false;
        p.on('open', () => { ok = true; peer = p; roomCode = code; res(code); });
        p.on('connection', conn => {
          conn.on('open', () => {});
          adopt(fromPeerConn(conn), 'host');
        });
        p.on('disconnected', () => { try { if (!p.destroyed) p.reconnect(); } catch {} });
        p.on('error', e => {
          if (!ok && e.type === 'unavailable-id' && n < 6) { p.destroy(); attempt(n + 1); }
          else if (!ok) { p.destroy(); rej(new Error(['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type) ? 'Room codes need internet — try “No internet” instead' : 'Couldn’t get a room code — try again')); }
        });
      };
      attempt(0);
    }));
  }
  async function hostWithQR() {
    await lib(VENDOR.qr);
    if (hostQR && !hostQR.used) return hostQR;
    const pc = new RTCPeerConnection({ iceServers: [] }), ch = pc.createDataChannel('game', { ordered: true });
    await pc.setLocalDescription(await pc.createOffer()); await gathered(pc);
    hostQR = { pc, ch, code: await pack(pc.localDescription), used: false };
    return hostQR;
  }
  async function acceptReply(str) {
    const d = await unpack(str);
    if (d.type !== 'answer') throw new Error('That’s the host’s code — scan the reply on the other phone');
    const s = hostQR; s.used = true;
    await s.pc.setRemoteDescription(d);
    adopt(fromChannel(s.pc, s.ch), 'host');
    hostQR = null;
  }

  /* ---------- joining ---------- */
  function joinWithCode(code) {
    return lib(VENDOR.peer).then(() => new Promise((res, rej) => {
      const p = new Peer(PEER_OPTS); let done = false;
      const fail = msg => { if (done) return; done = true; try { p.destroy(); } catch {} rej(new Error(msg)); };
      const t = setTimeout(() => fail('No game found with that code'), 15000);
      p.on('open', () => {
        const conn = p.connect(`dsgames-${cfg.game}-${code}`, { reliable: true, serialization: 'raw' });
        const L = fromPeerConn(conn);
        L.on('open', () => { if (done) return; done = true; clearTimeout(t); peer = p; adopt(L, 'guest'); res(); });
      });
      p.on('error', e => fail(e.type === 'peer-unavailable' ? 'No game found with that code — check it on the host’s phone' : 'Couldn’t connect — check your internet'));
    }));
  }
  async function joinWithOffer(str) {
    await lib(VENDOR.qr);
    const d = await unpack(str);
    if (d.type !== 'offer') throw new Error('That’s a reply code — scan the host’s code instead');
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.ondatachannel = e => { adopt(fromChannel(pc, e.channel), 'guest'); joinQR = null; rerender(); };
    await pc.setRemoteDescription(d); await pc.setLocalDescription(await pc.createAnswer()); await gathered(pc);
    joinQR = { pc, code: await pack(pc.localDescription) };
    setTimeout(() => { if (joinQR && joinQR.pc === pc && !links.length) { cfg.toast('Not connected yet — are both phones on the same Wi-Fi?'); } }, 45000);
    return joinQR;
  }

  /* ---------- screens ---------- */
  const esc = s => cfg.esc(s);
  function savePrefs() { try { localStorage.setItem(cfg.game + '-nearby', JSON.stringify(prefs)); } catch {} }
  function rerender() { const m = document.getElementById('modal'); if (m && m.dataset.nb) render(); }
  function render() {
    const connected = links.filter(l => l.open), maxed = connected.length >= (cfg.maxGuests || 1);
    let html = '';
    if (connected.length && (screen === 'main' || maxed)) screen = 'connected';
    if (!connected.length && screen === 'connected') screen = 'main';
    if (screen === 'main') html = `<h2>Play Nearby</h2>
      <div class="note">Play against someone on their own phone. One phone hosts, the other joins.</div>
      <div class="row"><span>Your name</span><input class="nb-input nb-name" style="max-width:55%" maxlength="14" value="${esc(prefs.name || '')}"></div>
      ${cfg.photos ? `<div class="row"><span>Share my photos</span><div class="seg" data-nbseg="share"><button data-v="1" class="${prefs.share ? 'on' : ''}">On</button><button data-v="0" class="${prefs.share ? '' : 'on'}">Off</button></div></div>
      <div class="note" style="margin:6px 0 0">${cfg.photoNote || 'When on, your photos are sent straight to the other phone for this game only. They’re never uploaded and aren’t kept.'}</div>` : ''}
      <button class="btn" data-nb="host">Host a game</button>
      <button class="btn ghost" data-nb="join">Join a game</button>
      <button class="btn ghost" data-nb="close">Cancel</button>`;
    else if (screen === 'connected') html = `<h2>Play Nearby</h2>
      <div class="note" style="font-size:15px;color:var(--ink)">${role === 'host' ? 'You’re hosting.' : 'You’ve joined.'} Connected to ${connected.length} ${connected.length === 1 ? 'player' : 'players'}.</div>
      ${cfg.status ? `<div class="note">${cfg.status()}</div>` : ''}
      ${cfg.photos ? `<div class="row"><span>Share my photos</span><div class="seg" data-nbseg="share"><button data-v="1" class="${prefs.share ? 'on' : ''}">On</button><button data-v="0" class="${prefs.share ? '' : 'on'}">Off</button></div></div>` : ''}
      ${role === 'host' && !maxed ? '<button class="btn ghost" data-nb="host">Add another player</button>' : ''}
      <button class="btn" data-nb="close">Back to the game</button>
      <button class="btn ghost" data-nb="leave" style="color:#c0392b">Leave nearby game</button>`;
    else if (screen === 'host') html = `<h2>Host a game</h2>
      <div class="seg" style="justify-content:center;margin-bottom:6px"><button data-tab="code" class="${tab === 'code' ? 'on' : ''}">Room code</button><button data-tab="qr" class="${tab === 'qr' ? 'on' : ''}">No internet</button></div>
      <div id="nb-pane">${tab === 'code' ? '<div class="nb-wait">Getting a room code…</div>' : '<div class="nb-wait">Preparing…</div>'}</div>
      <button class="btn ghost" data-nb="back">Back</button>`;
    else if (screen === 'join') html = `<h2>Join a game</h2>
      <div class="note">Enter the room code shown on the host’s phone:</div>
      <div class="nb-join"><input class="nb-codein" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD"><button class="btn" data-nb="join-code">Join</button></div>
      <div class="nb-or">No internet? Same Wi-Fi</div>
      <button class="btn ghost" data-nb="scan-offer">Scan the host’s QR code</button>
      <button class="btn ghost nb-small" data-nb="paste-offer">Paste a code sent by AirDrop or Messages</button>
      <button class="btn ghost" data-nb="back">Back</button>`;
    else if (screen === 'reply') html = `<h2>Show this to the host</h2>
      <div class="note">On the host’s phone tap <b>Scan their reply</b> and point it at this code.</div>
      <canvas class="nb-qr"></canvas>
      <button class="btn ghost nb-small" data-nb="share-reply">Send as text instead (AirDrop / Messages)</button>
      <div class="nb-wait">Waiting for the host to scan…</div>
      <button class="btn ghost" data-nb="cancel-join">Cancel</button>`;
    const m = cfg.openModal(html); m.dataset.nb = '1';
    wire(m);
    if (screen === 'host') fillHost(m);
    if (screen === 'reply' && joinQR) drawQR(m.querySelector('.nb-qr'), joinQR.code);
  }
  async function fillHost(m) {
    const pane = m.querySelector('#nb-pane'), want = tab;
    try {
      if (want === 'code') {
        const code = await hostWithCode();
        if (tab !== 'code' || !pane.isConnected) return;
        pane.innerHTML = `<div class="nb-code">${code}</div>
          <div class="note" style="text-align:center">On the other phone: <b>Play Nearby → Join a game</b> and enter this code.</div>
          <div class="nb-wait">Waiting for ${links.some(l => l.open) ? 'another player' : 'a player'} to join…</div>`;
      } else {
        const s = await hostWithQR();
        if (tab !== 'qr' || !pane.isConnected) return;
        pane.innerHTML = `<div class="note">Both phones need to be on the <b>same Wi-Fi</b> (no internet needed).<br><b>1.</b> On the other phone: Play Nearby → Join → <b>Scan the host’s QR code</b>.</div>
          <canvas class="nb-qr"></canvas>
          <button class="btn ghost nb-small" data-nb="share-offer">Send as text instead (AirDrop / Messages)</button>
          <div class="note" style="margin-top:10px"><b>2.</b> Their phone then shows a reply code:</div>
          <button class="btn" data-nb="scan-reply">Scan their reply</button>
          <button class="btn ghost nb-small" data-nb="paste-reply">Paste their reply</button>`;
        drawQR(pane.querySelector('.nb-qr'), s.code);
      }
    } catch (e) { if (pane.isConnected) pane.innerHTML = `<div class="note" style="color:#c0392b;text-align:center">${esc(e.message)}</div>`; }
  }
  function wire(m) {
    const nameIn = m.querySelector('.nb-name');
    if (nameIn) nameIn.addEventListener('change', () => { prefs.name = nameIn.value.trim().slice(0, 14) || prefs.name; savePrefs(); cfg.onPrefs && cfg.onPrefs(); });
    const codeIn = m.querySelector('.nb-codein');
    if (codeIn) codeIn.addEventListener('input', () => { codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); });
    m.addEventListener('click', async e => {
      const t = e.target, a = t.dataset.nb;
      if (nameIn && (a === 'host' || a === 'join')) { prefs.name = nameIn.value.trim().slice(0, 14) || prefs.name; savePrefs(); }
      const sg = t.closest('[data-nbseg] button');
      if (sg) { prefs.share = sg.dataset.v === '1'; savePrefs(); sg.parentElement.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === sg)); cfg.onPrefs && cfg.onPrefs(); return; }
      if (t.dataset.tab) { tab = t.dataset.tab; return render(); }
      switch (a) {
        case 'close': cfg.closeModal(); break;
        case 'host': screen = 'host'; render(); break;
        case 'join': screen = 'join'; render(); break;
        case 'back': screen = 'main'; render(); break;
        case 'leave': leave(); cfg.closeModal(); break;
        case 'join-code': {
          const code = codeIn.value.trim();
          if (code.length !== 4) return cfg.toast('Room codes are 4 letters');
          t.disabled = true; t.textContent = '…';
          try { await joinWithCode(code); screen = 'connected'; render(); }
          catch (err) { cfg.toast(err.message); t.disabled = false; t.textContent = 'Join'; }
          break;
        }
        case 'scan-offer': case 'paste-offer': {
          const str = a === 'scan-offer' ? await scanQR() : window.prompt('Paste the code from the host’s phone');
          if (!str) { screen = 'join'; return render(); }
          try { cfg.toast('Connecting…'); await joinWithOffer(str); screen = 'reply'; render(); }
          catch (err) { cfg.toast(err.message); screen = 'join'; render(); }
          break;
        }
        case 'share-offer': if (hostQR) shareText(hostQR.code); break;
        case 'share-reply': if (joinQR) shareText(joinQR.code); break;
        case 'scan-reply': case 'paste-reply': {
          const str = a === 'scan-reply' ? await scanQR() : window.prompt('Paste the reply code from the other phone');
          if (!str) { screen = 'host'; return render(); }
          try { await acceptReply(str); cfg.toast('Connecting…'); screen = 'connected'; render(); }
          catch (err) { cfg.toast(err.message); screen = 'host'; render(); }
          break;
        }
        case 'cancel-join': if (joinQR) { try { joinQR.pc.close(); } catch {} joinQR = null; } screen = 'join'; render(); break;
      }
    });
  }

  /* ---------- public ---------- */
  function leave() {
    const had = role;
    links.slice().forEach(l => l.close()); links = [];
    if (peer) { try { peer.destroy(); } catch {} peer = null; roomCode = null; }
    if (hostQR) { try { hostQR.pc.close(); } catch {} hostQR = null; }
    if (joinQR) { try { joinQR.pc.close(); } catch {} joinQR = null; }
    role = null; screen = 'main';
    if (had) cfg.onLeave && cfg.onLeave();
  }
  // shrink photos so each fits comfortably in one message
  async function photoPayload(blobs) {
    const out = [];
    for (const b of blobs) {
      if (!b) continue;
      const url = URL.createObjectURL(b), img = new Image();
      await new Promise(r => { img.onload = img.onerror = r; img.src = url; });
      const c = document.createElement('canvas'); c.width = c.height = 192;
      const k = Math.max(192 / img.naturalWidth, 192 / img.naturalHeight), w = img.naturalWidth * k, h = img.naturalHeight * k;
      c.getContext('2d').drawImage(img, (192 - w) / 2, (192 - h) / 2, w, h); URL.revokeObjectURL(url);
      out.push(c.toDataURL('image/jpeg', .75));
    }
    return out;
  }
  function loadImages(urls) { return (urls || []).filter(u => typeof u === 'string' && u.startsWith('data:image/')).slice(0, 8).map(u => { const im = new Image(); im.src = u; return im; }); }
  const style = document.createElement('style');
  style.textContent = `.nb-code{font:800 56px/1 ui-monospace,Menlo,monospace;letter-spacing:.14em;text-align:center;margin:12px 0 8px;color:var(--ink)}
.nb-qr{display:block;margin:8px auto;width:min(320px,82vw);height:auto;aspect-ratio:1;image-rendering:pixelated;background:#fff;border-radius:8px}
.nb-cam{position:relative;width:100%;max-width:340px;aspect-ratio:1;margin:0 auto 10px;border-radius:14px;overflow:hidden;background:#000}
.nb-cam video{width:100%;height:100%;object-fit:cover;display:block}
.nb-cam::after{content:"";position:absolute;inset:12%;border:3px solid rgba(255,255,255,.85);border-radius:14px}
.nb-join{display:flex;gap:8px;align-items:center}
.nb-join input{flex:1;min-width:0;font:800 26px ui-monospace,Menlo,monospace;letter-spacing:.2em;text-transform:uppercase;text-align:center;padding:10px;border:2px solid #cfdce1;border-radius:12px;color:var(--ink);background:#fff}
.nb-join .btn{width:auto;margin:0;padding:14px 20px}
.nb-input{border:0;border-bottom:1px solid #d6e0e5;font:600 16px inherit;padding:2px 0;color:var(--ink);background:none;border-radius:0;text-align:right}
.nb-small{padding:10px!important;font-size:14px!important;margin-top:6px!important}
.nb-wait{display:flex;align-items:center;justify-content:center;gap:8px;color:#5c6b73;font-size:14px;margin:10px 0}
.nb-wait::before{content:"";width:14px;height:14px;border-radius:50%;border:2px solid #cfdce1;border-top-color:var(--teal);animation:nbspin .8s linear infinite}
@keyframes nbspin{to{transform:rotate(360deg)}}
.nb-or{text-align:center;color:#8a979e;font-size:12px;margin:16px 0 6px;text-transform:uppercase;letter-spacing:.08em}`;
  document.head.appendChild(style);

  return {
    init(c) { cfg = c; try { prefs = Object.assign({ name: c.defaultName || 'Player', share: false }, JSON.parse(localStorage.getItem(c.game + '-nearby') || '{}')); } catch { prefs = { name: c.defaultName || 'Player', share: false }; } },
    open() { screen = links.some(l => l.open) ? 'connected' : 'main'; render(); },
    leave,
    get role() { return role; },
    get links() { return links.filter(l => l.open); },
    get active() { return !!role; },
    get name() { return prefs.name || cfg.defaultName || 'Player'; },
    get share() { return !!prefs.share; },
    photoPayload, loadImages, rerender
  };
})();
