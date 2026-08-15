(() => {
  const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
  const speedEndpoint = LOCAL_HOSTS.has(location.hostname)
    ? 'http://127.0.0.1:30100/speed'
    : `https://${location.hostname}:30100/speed`
  const remoteEndpoint = LOCAL_HOSTS.has(location.hostname)
    ? 'http://127.0.0.1:30100/remote'
    : `https://${location.hostname}:30100/remote`
  const tauriInvoke = window.__TAURI__?.core?.invoke

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
      if (toggle.querySelector('[data-balto-collapse-icon]')) continue
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
      toggle.insertBefore(icon, whale || toggle.firstChild)
    }
  }

  const mobileSidebarQuery = window.matchMedia('(max-width: 720px)')
  function syncMobileSidebar() {
    const sidebar = document.querySelector('.hHd-Xa_root')
    const isOpen = mobileSidebarQuery.matches
      && Boolean(sidebar?.querySelector('button[aria-label="Collapse sidebar"]'))
    document.body.classList.toggle('balto-mobile-sidebar-open', isOpen)

    let backdrop = document.querySelector('#balto-mobile-sidebar-backdrop')
    if (!isOpen) {
      backdrop?.remove()
      return
    }
    if (backdrop) return

    backdrop = document.createElement('button')
    backdrop.id = 'balto-mobile-sidebar-backdrop'
    backdrop.type = 'button'
    backdrop.setAttribute('aria-label', 'Close sidebar')
    backdrop.addEventListener('click', () => {
      document.querySelector('.hHd-Xa_root button[aria-label="Collapse sidebar"]')?.click()
    })
    document.body.append(backdrop)
  }
  mobileSidebarQuery.addEventListener?.('change', syncMobileSidebar)

  function closeMobileSidebarAfterSelection(event) {
    if (!mobileSidebarQuery.matches || !(event.target instanceof Element)) return
    const sidebar = event.target.closest('.hHd-Xa_root:not(.hHd-Xa_collapsed)')
    if (!sidebar) return

    const session = event.target.closest('[role="treeitem"]')
    const newSessionButton = event.target.closest('button[aria-label]')
    const selectedSession = Boolean(session && !session.hasAttribute('aria-expanded'))
    const selectedNewSession = /^(new session|new chat)$/i.test(newSessionButton?.getAttribute('aria-label') || '')
    if (!selectedSession && !selectedNewSession) return

    setTimeout(() => {
      if (!mobileSidebarQuery.matches) return
      sidebar.querySelector('button[aria-label="Collapse sidebar"]')?.click()
    }, 0)
  }
  document.addEventListener('click', closeMobileSidebarAfterSelection, true)

  let mobileViewportTimer = 0
  function syncMobileKeyboard() {
    clearTimeout(mobileViewportTimer)
    const viewport = window.visualViewport
    const active = document.activeElement
    const composerFocused = active instanceof Element
      && active.matches('textarea[placeholder="Message the agent"], textarea[placeholder="Describe what you want to build"]')
    const coveredHeight = mobileSidebarQuery.matches && viewport
      ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
      : 0
    const keyboardOpen = composerFocused && coveredHeight > 80
    document.documentElement.style.setProperty('--balto-keyboard-inset', `${Math.round(coveredHeight)}px`)
    document.body.classList.toggle('balto-keyboard-open', keyboardOpen)
  }

  function scheduleMobileKeyboardSync(delay = 0) {
    clearTimeout(mobileViewportTimer)
    mobileViewportTimer = window.setTimeout(syncMobileKeyboard, delay)
  }

  window.visualViewport?.addEventListener('resize', () => scheduleMobileKeyboardSync())
  window.visualViewport?.addEventListener('scroll', () => scheduleMobileKeyboardSync())
  window.addEventListener('resize', () => scheduleMobileKeyboardSync())
  document.addEventListener('focusin', () => {
    scheduleMobileKeyboardSync(50)
    window.setTimeout(syncMobileKeyboard, 250)
  })
  document.addEventListener('focusout', () => scheduleMobileKeyboardSync(100))

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
      description.textContent = 'Ready on your tailnet'
      link.href = remoteUrl
      link.textContent = remoteUrl.replace(/^https:\/\//, '')
      link.hidden = false
      copy.hidden = false
    } else {
      link.hidden = true
      copy.hidden = true
      description.textContent = !status.available
        ? 'Remote control is unavailable'
        : !status.tailscaleInstalled
          ? 'Install Tailscale on both devices'
          : !status.tailscaleSignedIn
            ? 'Sign this computer into your tailnet'
            : 'Turn on to create your remote control link'
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
    description.textContent = enabled ? 'Creating your remote control link' : 'Turning off remote control'
    try {
      const response = await fetch(remoteEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      const status = await response.json()
      if (!response.ok) throw new Error(status.error || 'Remote control could not be updated')
      renderRemoteStatus(status)
    } catch (error) {
      description.textContent = error instanceof Error ? error.message : 'Remote control could not be updated'
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
      if (button.isConnected) button.textContent = 'Copy remote link'
    }, 1400)
  }

  function mountRemoteSettings() {
    const existingRow = document.querySelector('#balto-remote-settings')
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((candidate) =>
      [...candidate.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'General') &&
      [...candidate.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'Models'),
    )
    const generalButton = dialog
      ? [...dialog.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'General')
      : null
    const generalIsActive = generalButton?.getAttribute('aria-current') === 'true'
      || generalButton?.classList.contains('VOzbGW_active')
    if (!generalIsActive) {
      existingRow?.remove()
      return
    }
    if (existingRow) return
    const options = dialog?.querySelector('[class*="_options"]')
    if (!options) return
    const row = document.createElement('section')
    row.id = 'balto-remote-settings'
    row.innerHTML = `
      <div class="balto-remote-copy-block">
        <strong>Remote control</strong>
        <span class="balto-remote-explainer">Open Balto securely from another device. Both devices must run Tailscale and be signed into the same tailnet.</span>
        <span class="balto-remote-description">Checking Tailscale</span>
        <a class="balto-remote-link" href="#" target="_blank" rel="noopener noreferrer" hidden></a>
        <a class="balto-tailscale-help" href="https://tailscale.com/download" target="_blank" rel="noopener noreferrer">Get Tailscale</a>
      </div>
      <div class="balto-remote-controls">
        <button type="button" class="balto-remote-copy" hidden>Copy remote link</button>
        <label class="balto-remote-switch">
          <input type="checkbox" aria-label="Remote control access">
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

  let attachmentTarget = null
  function attachmentInput() {
    let input = document.querySelector('#balto-attachment-input')
    if (input) return input

    input = document.createElement('input')
    input.id = 'balto-attachment-input'
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/webp,image/gif'
    input.multiple = true
    input.tabIndex = -1
    input.setAttribute('aria-hidden', 'true')
    input.addEventListener('change', () => {
      const files = [...(input.files || [])]
      const target = attachmentTarget?.isConnected
        ? attachmentTarget
        : document.querySelector('textarea[placeholder="Message the agent"]')
      attachmentTarget = null
      input.value = ''
      if (!target || files.length === 0) return

      const clipboardData = {
        files,
        items: files.map((file) => ({
          kind: 'file',
          type: file.type,
          getAsFile: () => file,
        })),
        types: ['Files'],
        getData: () => '',
      }
      const paste = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(paste, 'clipboardData', { value: clipboardData })
      target.dispatchEvent(paste)
      target.focus({ preventScroll: true })
    })
    document.body.append(input)
    return input
  }

  function openAttachmentPicker(event) {
    event.preventDefault()
    event.stopPropagation()
    const menu = event.currentTarget.closest('[role="listbox"]')
    const composer = menu?.closest('[data-composer-card="true"]')
    attachmentTarget = composer?.querySelector('textarea')
      || document.querySelector('textarea[placeholder="Message the agent"]')
    attachmentInput().click()
    document.querySelector('button[data-balto-add="true"][aria-expanded="true"]')?.click()
  }

  function mountAttachmentControl() {
    for (const trigger of document.querySelectorAll('button[aria-label="Commands"], button[data-balto-add="true"]')) {
      trigger.dataset.baltoAdd = 'true'
      trigger.setAttribute('aria-label', 'Add')
      trigger.title = 'Add'
    }

    for (const tooltip of document.querySelectorAll('[role="tooltip"]')) {
      if ((tooltip.textContent || '').trim() === 'Commands') tooltip.textContent = 'Add'
    }

    for (const menu of document.querySelectorAll('[role="listbox"][aria-label="Trigger suggestions"]')) {
      if (menu.querySelector('[data-balto-attachment-option]')) continue
      const viewport = menu.firstElementChild
      const commandsTitle = viewport?.querySelector('[role="presentation"][data-source="command"]')
      const firstOption = viewport?.querySelector('[role="option"]')
      if (!viewport || !commandsTitle || !firstOption) continue

      const addTitle = commandsTitle.cloneNode(true)
      addTitle.textContent = 'Add'
      addTitle.dataset.source = 'balto-attachment'

      const option = document.createElement('button')
      option.type = 'button'
      option.role = 'option'
      option.className = `${firstOption.className.replace(/\s*\S*active\S*/g, '')} balto-attachment-option`
      option.dataset.baltoAttachmentOption = 'true'
      option.setAttribute('aria-selected', 'false')
      option.setAttribute('aria-label', 'Attach file')
      const optionParts = [...firstOption.children]
      const nameClass = optionParts[0]?.className || ''
      const descriptionClass = optionParts[1]?.className || ''
      option.innerHTML = `
        <span class="balto-attachment-paperclip" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none"><path d="M9.5 12.5 15.9 6a3.2 3.2 0 0 1 4.6 4.5l-8.7 8.8a5 5 0 0 1-7.1-7.1l8.4-8.4a2.8 2.8 0 0 1 4 4l-8.4 8.4a.9.9 0 1 1-1.3-1.3l7.6-7.6"/></svg>
        </span>
        <span class="${nameClass}">Attach file</span>
        <span class="${descriptionClass}">PNG, JPG, WebP, or GIF</span>
      `
      option.addEventListener('mousedown', (event) => event.preventDefault())
      option.addEventListener('click', openAttachmentPicker)
      viewport.insertBefore(addTitle, commandsTitle)
      viewport.insertBefore(option, commandsTitle)
    }
  }

  openFreshSession()
  dismissInternalTestingNotice()
  brandVisibleWorkspace()
  brandCollapsedSidebar()
  syncMobileSidebar()
  mountRemoteSettings()
  simplifyEffortControls()
  mountAttachmentControl()

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
    #balto-live-bar .balto-sprinter { width: 43px; height: 30px; position: relative; display: grid; align-items: center; justify-items: end; overflow: visible; }
    #balto-live-bar .balto-sprinter img { position: relative; z-index: 1; width: 29px; height: 29px; transform-origin: 50% 72%; animation: balto-sprint 1.15s ease-in-out infinite; }
    #balto-live-bar .balto-sprinter::before,
    #balto-live-bar .balto-sprinter::after { content: ""; position: absolute; left: 0; height: 2px; border-radius: 2px; background: var(--balto-speed); opacity: .28; transform-origin: right center; animation: balto-trail 1.15s ease-in-out infinite; }
    #balto-live-bar .balto-sprinter::before { top: 10px; width: 10px; }
    #balto-live-bar .balto-sprinter::after { top: 19px; width: 7px; animation-delay: -.18s; }
    #balto-live-bar[data-state="live"] .balto-sprinter img { animation-duration: .42s; }
    #balto-live-bar[data-state="live"] .balto-sprinter::before,
    #balto-live-bar[data-state="live"] .balto-sprinter::after { opacity: .7; animation-duration: .42s; }
    #balto-live-bar[data-state="idle"] .balto-sprinter::before,
    #balto-live-bar[data-state="idle"] .balto-sprinter::after { opacity: .12; }
    #balto-live-bar .balto-meter { min-width: 96px; display: flex; align-items: baseline; justify-content: flex-end; gap: 6px; }
    #balto-live-bar .balto-value { color: var(--balto-speed); font: 650 26px/1 "Cascadia Code", Consolas, monospace; letter-spacing: -1.6px; font-variant-numeric: tabular-nums; text-shadow: 0 0 18px color-mix(in srgb, var(--balto-speed) 18%, transparent); }
    #balto-live-bar .balto-unit { color: rgba(245,247,248,.58); font-size: 8px; font-weight: 800; letter-spacing: 1px; }
    #balto-live-bar[data-state="idle"] .balto-value { color: #707780; text-shadow: none; }
    #balto-live-bar .balto-update-button { position: relative; width: 31px; height: 31px; flex: 0 0 31px; display: grid; place-items: center; margin-left: 3px; padding: 0; border: 1px solid rgba(84,223,155,.2); border-radius: 9px; color: #54df9b; background: rgba(84,223,155,.07); cursor: pointer; }
    #balto-live-bar .balto-update-button[hidden] { display: none; }
    #balto-live-bar .balto-update-button:hover { background: rgba(84,223,155,.14); }
    #balto-live-bar .balto-update-button:disabled { cursor: wait; opacity: .72; }
    #balto-live-bar .balto-update-button svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    #balto-live-bar .balto-update-button::after { content: ""; position: absolute; top: -3px; right: -3px; width: 7px; height: 7px; border: 2px solid #1c2025; border-radius: 50%; background: #ff6b35; box-shadow: 0 0 10px rgba(255,107,53,.5); }
    #balto-live-bar .balto-update-button[data-installing="true"] svg { animation: balto-update 700ms ease-in-out infinite alternate; }
    @keyframes balto-sprint { 0%, 100% { transform: translateY(1px) rotate(-1deg); } 50% { transform: translateY(-2px) rotate(1deg); } }
    @keyframes balto-trail { 0%, 100% { transform: scaleX(.45); opacity: .16; } 50% { transform: scaleX(1); opacity: .72; } }
    @keyframes balto-update { to { transform: translateY(3px); opacity: .5; } }
    [data-balto-brand="true"] { width: auto !important; display: inline-flex !important; align-items: center !important; gap: 9px !important; color: #f5f7f8 !important; }
    [data-balto-brand="true"] > img { width: 27px !important; height: 27px !important; flex: 0 0 27px; }
    button[aria-label="Open sidebar"] > svg:not([data-balto-collapse-icon]) { display: none !important; }
    button[aria-label="Open sidebar"] > svg[data-balto-collapse-icon] { width: 22px !important; height: 22px !important; display: block; flex: 0 0 22px; color: rgba(245,247,248,.86); }
    button:not([aria-label="Open sidebar"]) > svg[data-balto-collapse-icon] { display: none !important; }
    #balto-remote-settings { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-top: 4px; padding: 22px 0 2px; border-top: 1px solid rgba(255,255,255,.1); font-family: Inter, "Segoe UI", sans-serif; }
    .balto-remote-copy-block { min-width: 0; display: grid; gap: 5px; }
    .balto-remote-copy-block strong { color: rgba(255,255,255,.94); font-size: 14px; font-weight: 600; }
    .balto-remote-explainer { max-width: 490px; color: rgba(255,255,255,.7); font-size: 12px; line-height: 1.45; }
    .balto-remote-description { color: rgba(255,255,255,.53); font-size: 12px; line-height: 1.35; }
    .balto-remote-link { max-width: 380px; color: #72dba5; font-size: 12px; line-height: 1.35; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .balto-remote-link:hover { text-decoration: underline; }
    .balto-tailscale-help { width: fit-content; color: #7ca9ff; font-size: 12px; line-height: 1.35; text-decoration: none; }
    .balto-tailscale-help:hover { text-decoration: underline; }
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
    #balto-attachment-input { position: fixed !important; width: 1px !important; height: 1px !important; inset: auto auto 0 0 !important; opacity: 0 !important; pointer-events: none !important; }
    .balto-attachment-option { width: 100%; }
    .balto-attachment-paperclip { width: 18px; height: 18px; flex: 0 0 18px; display: inline-flex; align-items: center; justify-content: center; color: #72dba5; }
    .balto-attachment-paperclip svg { width: 17px; height: 17px; overflow: visible; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    [data-balto-hero="true"] { display: inline-flex !important; align-items: center; justify-content: center; }
    [data-balto-hero="true"] > img { width: 31px !important; height: 31px !important; }
    [class*="_previewBadge"] {
      display: none !important;
    }
    #balto-mobile-sidebar-backdrop { display: none; }
    @media (max-width: 720px) {
      html, body, #root { width: 100%; min-width: 0; overflow: hidden; }
      .pI_x6G_frame {
        grid-template-columns: 0 minmax(0, 1fr) 0 !important;
      }
      .pI_x6G_sidebarCol {
        position: relative;
        z-index: 1201;
        overflow: visible !important;
      }
      .pI_x6G_detailsCol,
      .pI_x6G_handle { display: none !important; }
      .hHd-Xa_root {
        position: fixed !important;
        z-index: 1202;
        inset: 0 auto 0 0;
        width: min(86vw, 320px) !important;
        height: 100dvh !important;
        padding: max(8px, env(safe-area-inset-top)) 12px max(8px, env(safe-area-inset-bottom)) !important;
        border-right: 1px solid rgba(255,255,255,.1);
        box-shadow: 24px 0 70px rgba(0,0,0,.46);
      }
      .hHd-Xa_root.hHd-Xa_collapsed {
        inset: max(8px, env(safe-area-inset-top)) auto auto max(8px, env(safe-area-inset-left));
        width: 44px !important;
        height: 44px !important;
        min-height: 44px !important;
        padding: 4px !important;
        overflow: visible !important;
        border: 1px solid rgba(255,255,255,.1);
        border-radius: 14px;
        background: rgba(27,30,35,.94);
        box-shadow: 0 8px 28px rgba(0,0,0,.3);
        backdrop-filter: blur(16px);
      }
      .hHd-Xa_collapsed > :not(.hHd-Xa_logoRow) { display: none !important; }
      .hHd-Xa_collapsed .hHd-Xa_logoRow {
        width: 36px;
        height: 36px;
        margin: 0;
        padding: 0;
        overflow: visible;
      }
      .hHd-Xa_collapsed .hHd-Xa_toggle {
        width: 36px !important;
        height: 36px !important;
      }
      .hHd-Xa_root:not(.hHd-Xa_collapsed) .hHd-Xa_logoRow {
        position: relative;
        z-index: 1;
        height: 52px;
        margin: 0 0 8px;
        padding: 4px 0;
      }
      .hHd-Xa_root:not(.hHd-Xa_collapsed) .hHd-Xa_toggle {
        width: 40px;
        height: 40px;
      }
      #balto-mobile-sidebar-backdrop {
        position: fixed;
        z-index: 1200;
        inset: 0;
        display: block;
        width: 100vw;
        height: 100dvh;
        padding: 0;
        border: 0;
        background: rgba(0,0,0,.58);
        cursor: default;
      }
      #balto-live-bar {
        top: max(8px, env(safe-area-inset-top));
        right: max(8px, env(safe-area-inset-right));
        height: 44px;
        gap: 5px;
        padding: 0 9px 0 8px;
        border-radius: 14px;
        pointer-events: none;
        transition: opacity .16s ease, transform .16s ease;
      }
      body.balto-mobile-sidebar-open #balto-live-bar {
        opacity: 0;
        transform: translateY(-8px);
      }
      #balto-live-bar .balto-sprinter { width: 38px; height: 26px; }
      #balto-live-bar .balto-sprinter img { width: 25px; height: 25px; }
      #balto-live-bar .balto-meter { min-width: 64px; gap: 4px; }
      #balto-live-bar .balto-value { font-size: 20px; letter-spacing: -1px; }
      #balto-live-bar .balto-unit { font-size: 7px; letter-spacing: .5px; }
      #balto-live-bar .balto-update-button { width: 29px; height: 29px; flex-basis: 29px; margin-left: 1px; }
      .wSkVaW_root {
        --dsh-chat-content-width: 100%;
        --dsh-composer-card-max-width: 100%;
        --dsh-composer-side-clearance: 0px;
      }
      .wSkVaW_header {
        position: relative;
        min-height: 88px !important;
        padding: 0 !important;
      }
      .wSkVaW_titleRow { display: none !important; }
      .wSkVaW_tabs {
        position: absolute !important;
        right: 0;
        bottom: 8px;
        left: 0;
        width: 100%;
        margin: 0 !important;
        padding: 0 !important;
        justify-content: center !important;
        gap: 32px !important;
      }
      .Md3f7G_scroll { padding: 12px 16px; }
      .uV2eYG_root {
        width: 100% !important;
        max-width: none !important;
        padding: 0 0 calc(8px + env(safe-area-inset-bottom)) !important;
      }
      .uV2eYG_card { width: 100% !important; max-width: none !important; gap: 8px; border-radius: 18px; }
      body.balto-keyboard-open .wSkVaW_composerStack {
        position: relative;
        z-index: 1300;
        transform: translateY(calc(-1 * var(--balto-keyboard-inset, 0px)));
      }
      body.balto-keyboard-open .Md3f7G_scroll {
        padding-bottom: calc(128px + var(--balto-keyboard-inset, 0px));
      }
      .uV2eYG_input,
      .uV2eYG_mirror,
      .uV2eYG_backdrop { font-size: 16px; padding-inline: 13px; }
      .uV2eYG_row { min-width: 0; gap: 6px; padding: 2px 6px 6px; }
      .uV2eYG_tools { flex: 0 0 auto; gap: 8px; }
      .balto-attachment-option { min-height: 44px; }
      .uV2eYG_modes,
      .uV2eYG_trailing { min-width: 0; gap: 6px; }
      .uV2eYG_trailing { flex: 1 1 auto; justify-content: flex-end; }
      ._7KE1Ra_root { min-width: 0; max-width: 118px; }
      ._7KE1Ra_trigger {
        width: 100% !important;
        min-width: 0;
        max-width: 100% !important;
        overflow: hidden;
      }
      ._7KE1Ra_triggerLabel {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      ._7KE1Ra_menu {
        right: -46px !important;
        left: auto !important;
        max-width: calc(100vw - 24px) !important;
      }
      .uV2eYG_select { max-width: 136px; padding-left: 5px; }
      .uV2eYG_root .FJxK0a_root,
      .uV2eYG_root [role="tooltip"] { display: none !important; }
      [role="tooltip"] { display: none !important; }
      .VOzbGW_overlay { align-items: stretch !important; padding: 0 !important; }
      .VOzbGW_panel {
        width: 100vw !important;
        max-width: none !important;
        height: 100dvh !important;
        max-height: none !important;
        border-radius: 0 !important;
        flex-direction: column !important;
      }
      .VOzbGW_nav {
        width: 100% !important;
        flex: 0 0 auto !important;
        gap: 8px !important;
        padding: max(10px, env(safe-area-inset-top)) 10px 0 !important;
      }
      .VOzbGW_navTitle { display: none; }
      .VOzbGW_navList {
        width: 100% !important;
        min-height: 46px;
        flex-direction: row !important;
        gap: 4px !important;
        padding-bottom: 8px !important;
        overflow-x: auto !important;
        overflow-y: hidden !important;
        scrollbar-width: none;
      }
      .VOzbGW_navList::-webkit-scrollbar { display: none; }
      .VOzbGW_navCell {
        width: auto !important;
        flex: 0 0 auto !important;
        height: 38px !important;
        padding: 8px 11px !important;
      }
      .VOzbGW_content { min-height: 0 !important; flex: 1 1 auto !important; }
      .VOzbGW_header { height: 48px !important; padding: 8px 10px !important; }
      .VOzbGW_options {
        min-height: 0 !important;
        padding: 0 16px calc(20px + env(safe-area-inset-bottom)) !important;
        overscroll-behavior: contain;
      }
      #balto-remote-settings {
        align-items: stretch;
        flex-direction: column;
        gap: 14px;
        padding-top: 18px;
      }
      .balto-remote-copy-block { width: 100%; }
      .balto-remote-controls { width: 100%; justify-content: space-between; }
      .balto-remote-copy { min-height: 38px; }
      .balto-remote-link {
        max-width: calc(100vw - 32px);
        overflow-wrap: anywhere;
        white-space: normal;
      }
    }
    @media (max-width: 360px) {
      #balto-live-bar { padding-right: 7px; }
      #balto-live-bar .balto-meter { min-width: 56px; }
      #balto-live-bar .balto-value { font-size: 18px; }
      .Md3f7G_scroll { padding-inline: 12px; }
      .uV2eYG_tools { gap: 4px; }
      ._7KE1Ra_root { max-width: 88px; }
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
    <button type="button" class="balto-update-button" aria-label="Install Balto update" title="Install Balto update" hidden>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v12m-5-5 5 5 5-5M6 20h12"/></svg>
    </button>
  `
  document.body.append(bar)

  const value = bar.querySelector('.balto-value')
  const updateButton = bar.querySelector('.balto-update-button')
  let availableUpdate = null
  let updateInstalling = false
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
      const isLive = data.state === 'live'
      target = isLive ? Number(data.tokensPerSecond || 0) : 0
      if (!isLive) {
        shown = 0
        value.textContent = '0.0'
      }
      bar.dataset.state = isLive ? 'live' : 'idle'
      bar.style.setProperty('--balto-speed', target >= 200 ? '#54df9b' : target >= 100 ? '#70d8ff' : target > 0 ? '#ffcc66' : '#707780')
    } catch {
      target = 0
      shown = 0
      value.textContent = '0.0'
      bar.dataset.state = 'idle'
    }
  }
  poll()
  setInterval(poll, 300)

  async function checkForUpdates() {
    if (!tauriInvoke || updateInstalling) return
    try {
      const update = await tauriInvoke('check_for_updates')
      availableUpdate = update.availableVersion || null
      updateButton.hidden = !availableUpdate
      if (availableUpdate) {
        updateButton.title = `Install Balto ${availableUpdate}`
        updateButton.setAttribute('aria-label', `Install Balto ${availableUpdate}`)
      }
    } catch {
      updateButton.hidden = true
    }
  }

  async function installAvailableUpdate() {
    if (!tauriInvoke || !availableUpdate || updateInstalling) return
    updateInstalling = true
    updateButton.disabled = true
    updateButton.dataset.installing = 'true'
    updateButton.title = `Installing Balto ${availableUpdate}`
    updateButton.setAttribute('aria-label', `Installing Balto ${availableUpdate}`)
    try {
      await tauriInvoke('install_update')
    } catch {
      updateInstalling = false
      updateButton.disabled = false
      updateButton.dataset.installing = 'false'
      updateButton.title = `Retry Balto ${availableUpdate}`
      updateButton.setAttribute('aria-label', `Retry Balto ${availableUpdate}`)
    }
  }

  updateButton.addEventListener('click', () => void installAvailableUpdate())
  if (tauriInvoke) {
    void checkForUpdates()
    setInterval(() => void checkForUpdates(), 60000)
  }

  const replacements = new Map([
    ['DeepSeek Harness', 'Balto Speedrunner'],
    ['DeepSeek-Harness', 'Balto Speedrunner'],
    ['deepseek_harness', 'Balto'],
    ['qwen3.8-27b-nvfp4-dspark', 'Balto Qwen 3.8 27B'],
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
      if (mutation.type === 'characterData') replaceText(mutation.target.parentNode)
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.TEXT_NODE) replaceText(node.parentNode)
        else if (node.nodeType === Node.ELEMENT_NODE) replaceText(node)
      }
    }
    dismissInternalTestingNotice()
    brandVisibleWorkspace()
    brandCollapsedSidebar()
    syncMobileSidebar()
    mountRemoteSettings()
    simplifyEffortControls()
    mountAttachmentControl()
  }).observe(document.body, { childList: true, characterData: true, subtree: true })

  setInterval(() => void refreshRemoteStatus(), 4000)
})()
