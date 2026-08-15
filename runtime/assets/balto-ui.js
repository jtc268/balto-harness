(() => {
  const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
  const speedEndpoint = LOCAL_HOSTS.has(location.hostname)
    ? 'http://127.0.0.1:30100/speed'
    : `https://${location.hostname}:30100/speed`
  const remoteEndpoint = LOCAL_HOSTS.has(location.hostname)
    ? 'http://127.0.0.1:30100/remote'
    : `https://${location.hostname}:30100/remote`

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

  function brandCollapsedSidebar() {
    for (const toggle of document.querySelectorAll('button[aria-label="Open sidebar"]')) {
      const whale = toggle.querySelector('svg[class*="_railFish"]')
      if (!whale || toggle.querySelector('[data-balto-collapse-icon]')) continue
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      icon.setAttribute('viewBox', '0 0 24 24')
      icon.setAttribute('fill', 'none')
      icon.setAttribute('stroke', 'currentColor')
      icon.setAttribute('stroke-width', '1.8')
      icon.setAttribute('stroke-linecap', 'round')
      icon.setAttribute('stroke-linejoin', 'round')
      icon.setAttribute('aria-hidden', 'true')
      icon.dataset.baltoCollapseIcon = 'true'
      icon.innerHTML = '<rect x="3.5" y="3.5" width="17" height="17" rx="3"></rect><path d="M9 4v16"></path>'
      toggle.insertBefore(icon, whale)
    }
  }

  let remoteRefreshActive = false
  let remoteChanging = false
  let remoteUrl = null

  function renderRemoteStatus(status) {
    const row = document.querySelector('#balto-remote-settings')
    if (!row) return
    const description = row.querySelector('.balto-remote-description')
    const link = row.querySelector('.balto-remote-link')
    const copy = row.querySelector('.balto-remote-copy')
    const toggle = row.querySelector('input')
    const enabled = Boolean(status.remoteEnabled)
    toggle.checked = enabled
    toggle.disabled = remoteChanging || !status.available || !status.tailscaleInstalled || !status.tailscaleSignedIn
    remoteUrl = enabled ? status.remoteUrl : null
    if (enabled && remoteUrl) {
      description.textContent = 'Private access is on'
      link.href = remoteUrl
      link.textContent = remoteUrl.replace(/^https:\/\//, '')
      link.hidden = false
      copy.hidden = false
    } else {
      link.hidden = true
      copy.hidden = true
      description.textContent = !status.available
        ? 'Private access is unavailable'
        : !status.tailscaleInstalled
          ? 'Tailscale is required'
          : !status.tailscaleSignedIn
            ? 'Sign in to Tailscale to enable'
            : 'Turn on to get your private link'
    }
  }

  async function refreshRemoteStatus() {
    if (remoteRefreshActive || remoteChanging || !document.querySelector('#balto-remote-settings')) return
    remoteRefreshActive = true
    try {
      const response = await fetch(remoteEndpoint, { cache: 'no-store' })
      renderRemoteStatus(await response.json())
    } catch {
      renderRemoteStatus({ available: false })
    } finally {
      remoteRefreshActive = false
    }
  }

  async function changeRemoteStatus(enabled) {
    const row = document.querySelector('#balto-remote-settings')
    if (!row || remoteChanging) return
    remoteChanging = true
    const description = row.querySelector('.balto-remote-description')
    const toggle = row.querySelector('input')
    toggle.disabled = true
    description.textContent = enabled ? 'Turning on private access' : 'Turning off private access'
    try {
      const response = await fetch(remoteEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      const status = await response.json()
      if (!response.ok) throw new Error(status.error || 'Private access could not be updated')
      renderRemoteStatus(status)
    } catch (error) {
      description.textContent = error instanceof Error ? error.message : 'Private access could not be updated'
      toggle.checked = !enabled
    } finally {
      remoteChanging = false
      await refreshRemoteStatus()
    }
  }

  async function copyRemoteLink(button) {
    if (!remoteUrl) return
    try {
      await navigator.clipboard.writeText(remoteUrl)
    } catch {
      const input = document.createElement('textarea')
      input.value = remoteUrl
      input.style.position = 'fixed'
      input.style.opacity = '0'
      document.body.append(input)
      input.select()
      document.execCommand('copy')
      input.remove()
    }
    button.textContent = 'Copied'
    setTimeout(() => {
      if (button.isConnected) button.textContent = 'Copy link'
    }, 1400)
  }

  function mountRemoteSettings() {
    if (document.querySelector('#balto-remote-settings')) return
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((candidate) =>
      candidate.querySelector('button')?.textContent?.trim() === 'General' && /Agent preset/.test(candidate.textContent || ''),
    )
    const options = dialog?.querySelector('[class*="_options"]')
    if (!options) return
    const row = document.createElement('section')
    row.id = 'balto-remote-settings'
    row.innerHTML = `
      <div class="balto-remote-copy-block">
        <strong>Private web app</strong>
        <span class="balto-remote-description">Checking Tailscale</span>
        <a class="balto-remote-link" href="#" target="_blank" rel="noopener noreferrer" hidden></a>
      </div>
      <div class="balto-remote-controls">
        <button type="button" class="balto-remote-copy" hidden>Copy link</button>
        <label class="balto-remote-switch">
          <input type="checkbox" aria-label="Private web app access">
          <span aria-hidden="true"></span>
        </label>
      </div>
    `
    row.querySelector('input').addEventListener('change', (event) => void changeRemoteStatus(event.currentTarget.checked))
    row.querySelector('.balto-remote-copy').addEventListener('click', (event) => void copyRemoteLink(event.currentTarget))
    options.append(row)
    void refreshRemoteStatus()
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
  brandCollapsedSidebar()
  mountRemoteSettings()
  simplifyEffortControls()

  const style = document.createElement('style')
  style.textContent = `
    #balto-live-bar {
      --balto-speed: #54df9b;
      position: fixed;
      z-index: 2147483646;
      top: 8px;
      right: 18px;
      height: 48px;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 13px 0 9px;
      border: 1px solid rgba(255,255,255,.09);
      border-radius: 15px;
      background: linear-gradient(145deg, rgba(35,39,45,.94), rgba(18,20,24,.95));
      box-shadow: 0 10px 28px rgba(0,0,0,.26);
      backdrop-filter: blur(18px);
      color: #f5f7f8;
      font-family: Inter, "Segoe UI", sans-serif;
      user-select: none;
    }
    #balto-live-bar .balto-sprinter { width: 35px; height: 30px; position: relative; display: grid; place-items: center; overflow: visible; }
    #balto-live-bar .balto-sprinter img { position: relative; z-index: 1; width: 29px; height: 29px; transform-origin: 50% 72%; animation: balto-sprint 1.15s ease-in-out infinite; }
    #balto-live-bar .balto-sprinter::before,
    #balto-live-bar .balto-sprinter::after { content: ""; position: absolute; right: 26px; height: 2px; border-radius: 2px; background: var(--balto-speed); opacity: .28; transform-origin: right center; animation: balto-trail 1.15s ease-in-out infinite; }
    #balto-live-bar .balto-sprinter::before { top: 10px; width: 13px; }
    #balto-live-bar .balto-sprinter::after { top: 19px; width: 9px; animation-delay: -.18s; }
    #balto-live-bar[data-state="live"] .balto-sprinter img { animation-duration: .42s; }
    #balto-live-bar[data-state="live"] .balto-sprinter::before,
    #balto-live-bar[data-state="live"] .balto-sprinter::after { opacity: .7; animation-duration: .42s; }
    #balto-live-bar[data-state="idle"] .balto-sprinter::before,
    #balto-live-bar[data-state="idle"] .balto-sprinter::after { opacity: .12; }
    #balto-live-bar .balto-meter { min-width: 96px; display: flex; align-items: baseline; justify-content: flex-end; gap: 6px; }
    #balto-live-bar .balto-value { color: var(--balto-speed); font: 650 26px/1 "Cascadia Code", Consolas, monospace; letter-spacing: -1.6px; font-variant-numeric: tabular-nums; text-shadow: 0 0 18px color-mix(in srgb, var(--balto-speed) 18%, transparent); }
    #balto-live-bar .balto-unit { color: rgba(245,247,248,.58); font-size: 8px; font-weight: 800; letter-spacing: 1px; }
    #balto-live-bar[data-state="idle"] .balto-value { color: #707780; text-shadow: none; }
    @keyframes balto-sprint { 0%, 100% { transform: translateY(1px) rotate(-1deg); } 50% { transform: translateY(-2px) rotate(1deg); } }
    @keyframes balto-trail { 0%, 100% { transform: scaleX(.45); opacity: .16; } 50% { transform: scaleX(1); opacity: .72; } }
    [data-balto-brand="true"] { width: auto !important; display: inline-flex !important; align-items: center !important; gap: 9px !important; color: #f5f7f8 !important; }
    [data-balto-brand="true"] > img { width: 27px !important; height: 27px !important; flex: 0 0 27px; }
    button[aria-label="Open sidebar"] > svg[class*="_railFish"] { display: none !important; }
    button[aria-label="Open sidebar"] > svg[data-balto-collapse-icon] { width: 22px !important; height: 22px !important; display: block; flex: 0 0 22px; color: rgba(245,247,248,.86); }
    #balto-remote-settings { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-top: 4px; padding: 22px 0 2px; border-top: 1px solid rgba(255,255,255,.1); font-family: Inter, "Segoe UI", sans-serif; }
    .balto-remote-copy-block { min-width: 0; display: grid; gap: 5px; }
    .balto-remote-copy-block strong { color: rgba(255,255,255,.94); font-size: 14px; font-weight: 600; }
    .balto-remote-description { color: rgba(255,255,255,.53); font-size: 12px; line-height: 1.35; }
    .balto-remote-link { max-width: 380px; color: #72dba5; font-size: 12px; line-height: 1.35; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .balto-remote-link:hover { text-decoration: underline; }
    .balto-remote-controls { display: flex; align-items: center; gap: 11px; }
    .balto-remote-copy { height: 30px; padding: 0 12px; border: 1px solid rgba(255,255,255,.14); border-radius: 15px; color: rgba(255,255,255,.82); background: rgba(255,255,255,.05); cursor: pointer; font: 500 12px/1 Inter, "Segoe UI", sans-serif; white-space: nowrap; }
    .balto-remote-copy:hover { background: rgba(255,255,255,.09); }
    .balto-remote-switch { position: relative; width: 42px; height: 24px; flex: 0 0 42px; }
    .balto-remote-switch input { position: absolute; opacity: 0; pointer-events: none; }
    .balto-remote-switch span { position: absolute; inset: 0; border-radius: 999px; background: rgba(255,255,255,.14); cursor: pointer; transition: background .18s ease; }
    .balto-remote-switch span::after { content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #b9c0c8; box-shadow: 0 1px 4px rgba(0,0,0,.35); transition: transform .18s ease, background .18s ease; }
    .balto-remote-switch input:checked + span { background: #39c989; }
    .balto-remote-switch input:checked + span::after { transform: translateX(18px); background: #fff; }
    .balto-remote-switch input:disabled + span { cursor: not-allowed; opacity: .46; }
    .balto-remote-switch input:focus-visible + span { outline: 2px solid #6da5ff; outline-offset: 2px; }
    .balto-sidebar-wordmark { display: flex; align-items: baseline; gap: 7px; white-space: nowrap; font-family: Inter, "Segoe UI", sans-serif; }
    .balto-sidebar-name { font-size: 15px; font-weight: 760; letter-spacing: -.3px; }
    .balto-sidebar-label { color: rgba(245,247,248,.48); font-size: 7px; font-weight: 850; letter-spacing: 1.35px; text-transform: uppercase; }
    [data-balto-hero="true"] { display: inline-flex !important; align-items: center; justify-content: center; }
    [data-balto-hero="true"] > img { width: 31px !important; height: 31px !important; }
    [class*="_previewBadge"] {
      display: none !important;
    }
    @media (prefers-reduced-motion: reduce) {
      #balto-live-bar .balto-sprinter img,
      #balto-live-bar .balto-sprinter::before,
      #balto-live-bar .balto-sprinter::after { animation: none !important; }
    }
  `
  document.head.append(style)

  const bar = document.createElement('div')
  bar.id = 'balto-live-bar'
  bar.dataset.state = 'idle'
  bar.innerHTML = `
    <div class="balto-sprinter" aria-hidden="true"><img src="/assets/balto-mark.svg" alt=""></div>
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
    ['@deepseek-ai/dsh-system-prompt', 'Balto system prompt'],
  ])
  function replaceText(root) {
    if (!(root instanceof Node)) return
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
    brandCollapsedSidebar()
    mountRemoteSettings()
    simplifyEffortControls()
  }).observe(document.body, { childList: true, subtree: true })

  setInterval(() => void refreshRemoteStatus(), 4000)
})()
