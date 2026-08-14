const tauri = window.__TAURI__
const invoke = tauri?.core?.invoke

const elements = {
  status: document.querySelector('#top-status'),
  primary: document.querySelector('#primary-action'),
  primaryLabel: document.querySelector('#primary-action span'),
  phaseTitle: document.querySelector('#phase-title'),
  phaseMessage: document.querySelector('#phase-message'),
  progress: document.querySelector('#progress-ring'),
  progressValue: document.querySelector('#progress-value'),
  gpu: document.querySelector('#check-gpu'),
  docker: document.querySelector('#check-docker'),
  model: document.querySelector('#check-model'),
  workspace: document.querySelector('#check-workspace'),
  warning: document.querySelector('#warning-card'),
  warningText: document.querySelector('#warning-text'),
  remoteToggle: document.querySelector('#remote-toggle'),
  remoteDescription: document.querySelector('#remote-description'),
  remoteUrl: document.querySelector('#remote-url'),
  settings: document.querySelector('#settings-dialog'),
  log: document.querySelector('#log-dialog'),
  logOutput: document.querySelector('#log-output'),
  updateButton: document.querySelector('#update-button'),
  updateRow: document.querySelector('#update-row'),
  updateDetail: document.querySelector('#update-detail'),
  updateTag: document.querySelector('#update-tag'),
}

let currentStatus = null
let busy = false
let autoSetupChecked = false
let workspaceOpened = false
let freshWorkspaceRequested = false
let availableUpdate = null
let remoteChanging = false
let updateInstalling = false

const previewStatus = {
  phase: 'not-installed',
  message: 'Ready to inspect this RTX 5090 system',
  progress: 4,
  gpuName: 'NVIDIA GeForce RTX 5090',
  gpuMemoryMib: 32607,
  gpuMemoryUsedMib: 31904,
  dockerInstalled: true,
  dockerReady: true,
  tailscaleInstalled: true,
  tailscaleSignedIn: true,
  tailscaleDnsName: 'husky-tower.tailbd005d.ts.net',
  remoteEnabled: false,
  inferenceReady: false,
  workspaceReady: false,
}

function setCheck(element, good, primary, detail) {
  element.classList.toggle('good', Boolean(good))
  element.classList.toggle('bad', good === false)
  element.querySelector('strong').textContent = primary
  element.querySelector('span').textContent = detail
}

function isWorking(phase) {
  return ['installing', 'downloading-runtime', 'downloading-model', 'starting', 'stopping'].includes(phase)
}

function withoutTrailingPeriod(value) {
  return String(value || '').replace(/[.]+$/, '')
}

function render(status) {
  currentStatus = status
  const progress = Number(status.progress || 0)
  const ready = Boolean(status.workspaceReady && status.inferenceReady)
  const failed = status.phase === 'failed'

  elements.progress.style.setProperty('--progress', Math.max(0, Math.min(100, progress)))
  elements.progressValue.textContent = `${progress}%`
  elements.phaseMessage.textContent = withoutTrailingPeriod(status.message || 'Waiting for Balto')
  elements.status.classList.toggle('ready', ready)
  elements.status.classList.toggle('error', failed)

  if (ready) {
    elements.status.querySelector('span').textContent = 'Local stack ready'
    elements.phaseTitle.textContent = 'Balto is ready to work'
    elements.primaryLabel.textContent = 'Open Balto workspace'
  } else if (failed) {
    elements.status.querySelector('span').textContent = 'Setup needs attention'
    elements.phaseTitle.textContent = 'Setup stopped'
    elements.primaryLabel.textContent = 'Finish setup'
  } else if (isWorking(status.phase)) {
    elements.status.querySelector('span').textContent = 'Setting up Balto'
    elements.phaseTitle.textContent = status.phase === 'downloading-model' ? 'Downloading the model' : 'Building the local stack'
    elements.primaryLabel.textContent = 'Starting Balto'
  } else {
    elements.status.querySelector('span').textContent = 'Ready for setup'
    elements.phaseTitle.textContent = status.gpuName ? 'This machine is compatible' : 'Inspecting your machine'
    elements.primaryLabel.textContent = 'Start'
  }

  elements.primary.disabled = busy || isWorking(status.phase)
  setCheck(
    elements.gpu,
    Boolean(status.gpuName?.includes('5090')),
    status.gpuName || 'RTX 5090',
    status.gpuMemoryMib ? `${(status.gpuMemoryMib / 1024).toFixed(1)} GB VRAM detected` : 'Detecting GPU and VRAM',
  )
  setCheck(
    elements.docker,
    status.dockerReady,
    'Inference engine',
    status.dockerReady ? 'High-speed local runtime ready' : status.dockerInstalled ? 'Installed, waiting to start' : 'Balto will prepare this automatically',
  )
  setCheck(
    elements.model,
    status.inferenceReady,
    'Qwen model',
    status.inferenceReady ? 'Downloaded and ready' : 'Optimized for this RTX 5090',
  )
  setCheck(
    elements.workspace,
    status.workspaceReady,
    'Coding workspace',
    status.workspaceReady ? 'Ready for efficient tool calls' : 'Efficient local tool calls',
  )

  elements.warning.hidden = !status.warning
  elements.warningText.textContent = status.warning || ''

  elements.remoteToggle.checked = Boolean(status.remoteEnabled)
  elements.remoteToggle.disabled = !ready || !status.tailscaleInstalled || !status.tailscaleSignedIn || busy || remoteChanging
  if (status.remoteEnabled && status.remoteUrl) {
    elements.remoteDescription.textContent = 'Your private web app is ready'
    elements.remoteUrl.hidden = false
    elements.remoteUrl.textContent = status.remoteUrl
    elements.remoteUrl.href = status.remoteUrl
  } else {
    elements.remoteUrl.hidden = true
    elements.remoteDescription.textContent = !ready
      ? 'Available after Balto starts'
      : status.tailscaleSignedIn
        ? 'Turn on to get your private web app link'
        : 'Sign in to Tailscale to get your private web app link'
  }

  if (ready && !workspaceOpened && invoke) {
    workspaceOpened = true
    const fresh = freshWorkspaceRequested
    freshWorkspaceRequested = false
    setTimeout(() => invoke('open_workspace', { fresh }).catch(() => { workspaceOpened = false }), 650)
  }
}

async function refresh() {
  try {
    const status = invoke ? await invoke('get_status') : previewStatus
    render(status)
    if (!autoSetupChecked && invoke) {
      autoSetupChecked = true
      const setupRecovery = status.phase === 'failed' && Number(status.progress || 0) < 100
      const serviceRecovery = ['degraded', 'stopped'].includes(status.phase)
      if ((status.phase === 'not-installed' || setupRecovery || serviceRecovery) && status.gpuName?.includes('5090')) {
        freshWorkspaceRequested = status.phase === 'not-installed' || setupRecovery
        await runAction('setup_stack')
      }
    }
  } catch (error) {
    elements.phaseMessage.textContent = String(error)
    elements.status.classList.add('error')
    elements.status.querySelector('span').textContent = 'Status unavailable'
  }
}

async function runAction(command, payload = {}) {
  if (!invoke) return
  busy = true
  elements.primary.disabled = true
  try {
    await invoke(command, payload)
    await new Promise((resolve) => setTimeout(resolve, 450))
    await refresh()
  } catch (error) {
    elements.phaseMessage.textContent = String(error)
  } finally {
    busy = false
  }
}

async function checkForUpdates() {
  if (!invoke) return
  try {
    const update = await invoke('check_for_updates')
    availableUpdate = update.availableVersion || null
    elements.updateDetail.textContent = availableUpdate
      ? `Balto Speedrunner ${availableUpdate} is ready`
      : `Balto Speedrunner ${update.currentVersion}`
    elements.updateTag.textContent = availableUpdate ? `v${availableUpdate}` : 'CURRENT'
    elements.updateTag.classList.toggle('green', !availableUpdate)
    elements.updateRow.classList.toggle('available', Boolean(availableUpdate))
    elements.updateButton.hidden = !availableUpdate
  } catch {
    elements.updateDetail.textContent = 'Signed updates check automatically'
    elements.updateTag.textContent = 'AUTO'
  }
}

async function installAvailableUpdate() {
  if (!availableUpdate || !invoke) {
    await checkForUpdates()
    return
  }
  if (updateInstalling) return
  updateInstalling = true
  elements.updateRow.disabled = true
  elements.updateButton.disabled = true
  elements.updateButton.setAttribute('aria-label', 'Installing Balto update')
  elements.updateButton.title = 'Installing update'
  elements.updateRow.classList.add('installing')
  elements.updateTag.textContent = 'INSTALLING'
  elements.updateDetail.textContent = `Verifying and installing ${availableUpdate}`
  try {
    await invoke('install_update')
  } catch (error) {
    elements.updateDetail.textContent = String(error)
    elements.updateTag.textContent = 'RETRY'
    elements.updateRow.disabled = false
    elements.updateButton.disabled = false
    elements.updateButton.setAttribute('aria-label', 'Retry Balto update')
    elements.updateButton.title = 'Retry update'
    elements.updateRow.classList.remove('installing')
    updateInstalling = false
  }
}

async function changeRemoteAccess(enabled) {
  if (!invoke || remoteChanging) return
  remoteChanging = true
  elements.remoteToggle.disabled = true
  elements.remoteDescription.textContent = enabled ? 'Creating your private web app link' : 'Turning off private access'
  try {
    await invoke(enabled ? 'enable_remote' : 'disable_remote')
    for (let attempt = 0; attempt < 45; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const status = await invoke('get_status')
      if (status.phase === 'failed') throw new Error(status.message)
      if (Boolean(status.remoteEnabled) === enabled) {
        render(status)
        return
      }
    }
    throw new Error(enabled ? 'The private link is taking longer than expected' : 'Private access is still turning off')
  } catch (error) {
    elements.phaseMessage.textContent = withoutTrailingPeriod(error)
  } finally {
    remoteChanging = false
    await refresh()
  }
}

elements.primary.addEventListener('click', async () => {
  if (currentStatus?.workspaceReady) {
    await runAction('open_workspace', { fresh: false })
    return
  }
  freshWorkspaceRequested = true
  await runAction('setup_stack')
})

elements.remoteToggle.addEventListener('change', async () => {
  await changeRemoteAccess(elements.remoteToggle.checked)
})

elements.settings.addEventListener('click', (event) => {
  if (event.target === elements.settings) elements.settings.close()
})
document.querySelector('#settings-button').addEventListener('click', () => elements.settings.showModal())
elements.updateButton.addEventListener('click', installAvailableUpdate)
elements.updateRow.addEventListener('click', installAvailableUpdate)
document.querySelector('#view-log').addEventListener('click', () => elements.log.showModal())
document.querySelector('#close-log').addEventListener('click', () => elements.log.close())
document.querySelector('#coffee-button').addEventListener('click', async () => {
  const url = 'https://buymeacoffee.com/refresh1'
  if (tauri?.opener?.openUrl) await tauri.opener.openUrl(url)
  else window.open(url, '_blank', 'noopener,noreferrer')
})
elements.remoteUrl.addEventListener('click', async (event) => {
  if (!tauri?.opener?.openUrl) return
  event.preventDefault()
  await tauri.opener.openUrl(elements.remoteUrl.href)
})

refresh()
setTimeout(checkForUpdates, 1800)
setInterval(refresh, 1800)
