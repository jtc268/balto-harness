(() => {
  const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
  const speedEndpoint = LOCAL_HOSTS.has(location.hostname)
    ? 'http://127.0.0.1:30100/speed'
    : `https://${location.hostname}:30100/speed`

  document.title = 'Balto Speedrunner'

  const style = document.createElement('style')
  style.textContent = `
    #balto-live-bar {
      --balto-speed: #54df9b;
      position: fixed;
      z-index: 2147483646;
      top: 8px;
      right: 142px;
      height: 50px;
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 0 14px 0 10px;
      border: 1px solid rgba(255,255,255,.09);
      border-radius: 15px;
      background: linear-gradient(145deg, rgba(35,39,45,.94), rgba(18,20,24,.95));
      box-shadow: 0 10px 28px rgba(0,0,0,.26);
      backdrop-filter: blur(18px);
      color: #f5f7f8;
      font-family: Inter, "Segoe UI", sans-serif;
      user-select: none;
    }
    #balto-live-bar img { width: 31px; height: 31px; }
    #balto-live-bar .balto-brand { display: flex; align-items: center; gap: 8px; padding-right: 12px; border-right: 1px solid rgba(255,255,255,.08); }
    #balto-live-bar .balto-name { font-size: 12px; font-weight: 760; letter-spacing: -.2px; }
    #balto-live-bar .balto-meter { min-width: 111px; display: flex; align-items: baseline; justify-content: flex-end; gap: 6px; }
    #balto-live-bar .balto-value { color: var(--balto-speed); font: 650 26px/1 "Cascadia Code", Consolas, monospace; letter-spacing: -1.6px; font-variant-numeric: tabular-nums; text-shadow: 0 0 18px color-mix(in srgb, var(--balto-speed) 18%, transparent); }
    #balto-live-bar .balto-unit { color: rgba(245,247,248,.58); font-size: 8px; font-weight: 800; letter-spacing: 1px; }
    #balto-live-bar[data-state="idle"] .balto-value { color: #707780; text-shadow: none; }
    @media (max-width: 900px) { #balto-live-bar .balto-brand { display: none; } }
  `
  document.head.append(style)

  const bar = document.createElement('div')
  bar.id = 'balto-live-bar'
  bar.dataset.state = 'idle'
  bar.innerHTML = `
    <div class="balto-brand"><img src="/assets/balto-mark.svg" alt=""><span class="balto-name">Balto</span></div>
    <div class="balto-meter"><span class="balto-value">0</span><span class="balto-unit">TOK/S</span></div>
  `
  document.body.append(bar)

  const value = bar.querySelector('.balto-value')
  let shown = 0
  let target = 0
  function animate() {
    shown += (target - shown) * 0.22
    if (Math.abs(target - shown) < 0.08) shown = target
    value.textContent = shown >= 100 ? shown.toFixed(0) : shown.toFixed(1)
    requestAnimationFrame(animate)
  }
  animate()

  async function poll() {
    try {
      const response = await fetch(speedEndpoint, { cache: 'no-store' })
      const data = await response.json()
      target = Number(data.tokensPerSecond || 0)
      bar.dataset.state = data.state === 'live' ? 'live' : target > 0 ? 'complete' : 'idle'
      bar.style.setProperty('--balto-speed', target >= 200 ? '#54df9b' : target >= 100 ? '#70d8ff' : target > 0 ? '#ffcc66' : '#707780')
    } catch {
      bar.dataset.state = 'idle'
    }
  }
  poll()
  setInterval(poll, 300)

  const replacements = new Map([
    ['DeepSeek Harness', 'Balto Speedrunner'],
    ['DeepSeek-Harness', 'Balto Speedrunner'],
  ])
  function replaceText(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      let next = node.nodeValue
      for (const [from, to] of replacements) next = next.split(from).join(to)
      if (next !== node.nodeValue) node.nodeValue = next
    }
  }
  replaceText(document.body)
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.TEXT_NODE) replaceText(node.parentNode)
        else if (node.nodeType === Node.ELEMENT_NODE) replaceText(node)
      }
    }
  }).observe(document.body, { childList: true, subtree: true })
})()
