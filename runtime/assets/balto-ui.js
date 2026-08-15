(() => {
  const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
  const speedEndpoint = LOCAL_HOSTS.has(location.hostname)
    ? 'http://127.0.0.1:30100/speed'
    : `https://${location.hostname}:30100/speed`

  document.title = 'Balto Speedrunner'

  function openFreshSession() {
    if (new URLSearchParams(location.search).get('balto') !== 'new') return
    history.replaceState(null, '', `${location.pathname}${location.hash}`)

    const startedAt = Date.now()
    const tryOpen = () => {
      const button = [...document.querySelectorAll('button[aria-label]')].find((candidate) => {
        const label = candidate.getAttribute('aria-label') || ''
        return /^(new session|new chat)$/i.test(label) || label.includes('新建会话')
      })
      if (button) {
        button.click()
        return
      }
      if (Date.now() - startedAt < 30000) setTimeout(tryOpen, 100)
    }
    tryOpen()
  }

  let testingNoticeDismissed = false
  function dismissInternalTestingNotice() {
    if (testingNoticeDismissed) return
    const dialog = [...document.querySelectorAll('[role="dialog"], dialog')].find((candidate) =>
      /Internal Testing Notice/i.test(candidate.textContent || ''),
    )
    if (!dialog) return
    const continueButton = [...dialog.querySelectorAll('button')].find((candidate) =>
      /^Continue$/i.test((candidate.textContent || '').trim()),
    )
    if (!continueButton) return
    testingNoticeDismissed = true
    continueButton.click()
  }

  function brandVisibleWorkspace() {
    const wordmark = [...document.querySelectorAll('button[aria-label]')].find((candidate) =>
      candidate.querySelector(':scope > svg[viewBox="0 0 182 24"]'),
    )
    if (wordmark && !wordmark.dataset.baltoBrand) {
      wordmark.dataset.baltoBrand = 'true'
      const icon = document.createElement('img')
      icon.src = '/assets/balto-mark.svg'
      icon.alt = ''
      const name = document.createElement('span')
      name.className = 'balto-sidebar-name'
      name.textContent = 'Balto'
      const label = document.createElement('span')
      label.className = 'balto-sidebar-label'
      label.textContent = 'Speedrunner'
      const text = document.createElement('span')
      text.className = 'balto-sidebar-wordmark'
      text.append(name, label)
      wordmark.replaceChildren(icon, text)
    }

    const heroText = [...document.querySelectorAll('span')].find((candidate) =>
      (candidate.textContent || '').trim() === 'Into the Unknown',
    )
    if (heroText) {
      heroText.textContent = 'Ready to run'
      const hero = heroText.parentElement
      const iconContainer = hero?.querySelector('span:has(> svg)')
      if (iconContainer && !iconContainer.dataset.baltoHero) {
        iconContainer.dataset.baltoHero = 'true'
        const icon = document.createElement('img')
        icon.src = '/assets/balto-mark.svg'
        icon.alt = ''
        iconContainer.replaceChildren(icon)
      }
    }
  }

  function simplifyEffortControls() {
    for (const effort of document.querySelectorAll('[class*="triggerEffort"]')) {
      if ((effort.textContent || '').trim() !== 'Off') continue
      effort.style.display = 'none'
      const trigger = effort.closest('button')
      if (!trigger) continue
      trigger.title = (trigger.title || '').replace(/\s+\S+\s+Off\s*$/, '')
      trigger.setAttribute(
        'aria-label',
        (trigger.getAttribute('aria-label') || '').replace(/,?\s*reasoning effort Off\s*$/i, ''),
      )
    }

    for (const label of document.querySelectorAll('[class*="cellLabel"]')) {
      if ((label.textContent || '').trim() !== 'Effort') continue
      const row = label.closest('[role="menuitem"]')
      const value = row?.querySelector('[class*="cellValue"]')
      if (row && (value?.textContent || '').trim() === 'Off') row.style.display = 'none'
    }
  }

  openFreshSession()
  dismissInternalTestingNotice()
  brandVisibleWorkspace()
  simplifyEffortControls()

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
    [data-balto-brand="true"] { width: auto !important; display: inline-flex !important; align-items: center !important; gap: 9px !important; color: #f5f7f8 !important; }
    [data-balto-brand="true"] > img { width: 27px !important; height: 27px !important; flex: 0 0 27px; }
    .balto-sidebar-wordmark { display: flex; align-items: baseline; gap: 7px; white-space: nowrap; font-family: Inter, "Segoe UI", sans-serif; }
    .balto-sidebar-name { font-size: 15px; font-weight: 760; letter-spacing: -.3px; }
    .balto-sidebar-label { color: rgba(245,247,248,.48); font-size: 7px; font-weight: 850; letter-spacing: 1.35px; text-transform: uppercase; }
    [data-balto-hero="true"] { display: inline-flex !important; align-items: center; justify-content: center; }
    [data-balto-hero="true"] > img { width: 31px !important; height: 31px !important; }
    [class*="_previewBadge"] {
      align-self: center !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      margin-top: 0 !important;
      padding-top: 0 !important;
      padding-bottom: 0 !important;
    }
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
    dismissInternalTestingNotice()
    brandVisibleWorkspace()
    simplifyEffortControls()
  }).observe(document.body, { childList: true, subtree: true })
})()
