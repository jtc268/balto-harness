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
  journey: document.querySelector('#setup-journey'),
  journeyTitle: document.querySelector('#journey-title'),
  journeyDetail: document.querySelector('#journey-detail'),
  journeyStep: document.querySelector('#journey-step'),
  journeyEta: document.querySelector('#journey-eta'),
  journeyNote: document.querySelector('#journey-note'),
  track: document.querySelector('#balto-track'),
  downloadDetail: document.querySelector('#download-detail'),
  elapsedTime: document.querySelector('#elapsed-time'),
  setupSteps: [
    document.querySelector('#setup-step-system'),
    document.querySelector('#setup-step-runtime'),
    document.querySelector('#setup-step-model'),
    document.querySelector('#setup-step-launch'),
  ],
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
let workspaceOpened = false
let freshWorkspaceRequested = false
let availableUpdate = null
let remoteChanging = false
let updateInstalling = false
let observedSetupStartedAt = null
let setupRecoveryAttempts = 0
let setupRecoveryTimer = null
const MAX_SETUP_RECOVERY_ATTEMPTS = 4

const idlePreviewStatus = {
  phase: 'not-installed',
  stage: 'system-check',
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

const setupPreviewStatus = {
  ...idlePreviewStatus,
  phase: 'downloading-model',
  stage: 'model',
  message: 'Preparing Qwen 3.8 27B. 9.8 GB downloaded and verified. Interrupted downloads resume automatically',
  progress: 64,
  downloadedGb: 9.8,
  downloadTotalGb: 24,
  downloadRateMbps: 91.4,
  etaSeconds: 155,
  startedAt: new Date(Date.now() - 7 * 60 * 1000 - 24 * 1000).toISOString(),
  inferenceReady: false,
  workspaceReady: false,
}

const previewStatus = new URLSearchParams(location.search).get('preview') === 'setup'
  ? setupPreviewStatus
  : idlePreviewStatus

const stageExperience = {
  'system-check': {
    step: 0,
    title: 'Checking your RTX 5090',
    detail: 'Balto is confirming GPU memory, free storage, and the Windows features needed for fast local AI',
    eta: 'Usually under a minute',
    activity: 'Checking compatibility and available storage',
    note: 'No choices needed. Balto uses the fastest safe configuration for this GPU',
  },
  windows: {
    step: 0,
    title: 'Preparing Windows',
    detail: 'Balto is enabling the Windows support required to run the NVIDIA inference stack locally',
    eta: 'Usually 1 to 3 minutes',
    activity: 'Preparing Windows inference support',
    note: 'Windows may ask for approval once. If a restart is needed, Balto resumes automatically',
  },
  engine: {
    step: 1,
    title: 'Building the local engine',
    detail: 'Balto is installing and starting the private runtime that connects Qwen directly to your RTX 5090',
    eta: 'Usually 2 to 8 minutes',
    activity: 'Installing the high-speed inference engine',
    note: 'This is a one-time setup. Balto keeps the infrastructure out of your way after today',
  },
  'app-runtime': {
    step: 1,
    title: 'Preparing your coding workspace',
    detail: 'Balto is creating Documents\\Balto and installing its private app runtime, local tools, and coding interface',
    eta: 'Usually 1 to 3 minutes',
    activity: 'Installing the Balto workspace and local tools',
    note: 'Everything stays on this PC and launches automatically with Balto',
  },
  'inference-runtime': {
    step: 1,
    title: 'Tuning the inference stack',
    detail: 'Balto is downloading the pinned SGLang runtime and the exact RTX 5090 configuration',
    eta: 'Usually 2 to 10 minutes',
    activity: 'Downloading cached runtime layers',
    note: 'Completed layers are cached, so interrupted setup and future updates are much faster',
  },
  model: {
    step: 2,
    title: 'Qwen is coming aboard',
    detail: 'Balto is downloading the optimized Qwen 3.8 27B model and its speed draft. This is the largest step',
    eta: 'Usually 5 to 20 minutes',
    activity: 'Connecting to the model host',
    note: 'Keep Balto open. Every completed file is preserved and interrupted downloads resume automatically',
  },
  launch: {
    step: 3,
    title: 'Loading Qwen onto your GPU',
    detail: 'Balto is loading the model into VRAM, starting the gateway, and opening your fresh coding workspace',
    eta: 'Usually 1 to 3 minutes',
    activity: 'Starting the model and coding interface',
    note: 'The first GPU load takes a little longer. Future launches reuse everything already installed',
  },
  ready: {
    step: 3,
    title: 'Balto made it',
    detail: 'Qwen is loaded on your RTX 5090 and the coding workspace is ready',
    eta: 'Ready to code',
    activity: 'Setup complete',
    note: 'Opening a fresh Balto coding session now',
  },
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

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  if (minutes < 60) return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

function inferredStage(status, progress, ready) {
  if (ready) return 'ready'
  if (status.stage && stageExperience[status.stage]) return status.stage
  if (status.phase === 'downloading-model' || progress >= 47 && progress < 88) return 'model'
  if (status.phase === 'starting' || progress >= 88) return 'launch'
  if (status.phase === 'downloading-runtime' || progress >= 20) return 'app-runtime'
  if (status.phase === 'installing' || progress >= 10) return 'engine'
  return 'system-check'
}

function renderJourney(status, progress, ready, failed, recovering) {
  const working = isWorking(status.phase)
  const stage = inferredStage(status, progress, ready)
  const experience = stageExperience[stage] || stageExperience['system-check']
  const step = experience.step

  document.body.classList.toggle('setup-active', (working && !failed) || recovering)
  document.body.classList.toggle('setup-failed', failed && !recovering)
  document.body.classList.toggle('setup-complete', ready)
  elements.track.style.setProperty('--progress', Math.max(0, Math.min(100, progress)))
  elements.journeyTitle.textContent = recovering ? 'Balto is finishing setup' : failed ? 'Balto paused here' : experience.title
  elements.journeyDetail.textContent = recovering
    ? 'This step needs another pass. Balto is retrying automatically and reusing everything already downloaded'
    : failed
    ? 'Your completed work is safe. Balto will continue from this point when setup resumes'
    : experience.detail
  elements.journeyStep.textContent = ready ? '4 steps complete' : `Step ${step + 1} of 4`
  elements.journeyNote.textContent = recovering
    ? 'No action needed. Balto will keep moving as soon as this step is ready'
    : failed
    ? 'Open the setup log for the exact issue, then choose Finish setup to continue'
    : experience.note

  if (working && !observedSetupStartedAt) observedSetupStartedAt = Date.now()
  const startedAt = status.startedAt ? Date.parse(status.startedAt) : observedSetupStartedAt
  const elapsedSeconds = startedAt && Number.isFinite(startedAt) ? (Date.now() - startedAt) / 1000 : 0
  elements.elapsedTime.textContent = ready
    ? `Completed in ${formatDuration(elapsedSeconds)}`
    : `Elapsed ${formatDuration(elapsedSeconds)}`

  const etaSeconds = Number(status.etaSeconds)
  elements.journeyEta.textContent = ready
    ? 'Ready to code'
    : etaSeconds > 0
      ? `About ${formatDuration(etaSeconds)} left`
      : experience.eta

  if (stage === 'model') {
    const downloaded = Number(status.downloadedGb || 0)
    const total = Number(status.downloadTotalGb || 24)
    const rate = Number(status.downloadRateMbps || 0)
    const pieces = [downloaded > 0 ? `${downloaded.toFixed(1)} GB of about ${total.toFixed(0)} GB` : experience.activity]
    if (rate > 0) pieces.push(`${rate.toFixed(0)} MB/s`)
    elements.downloadDetail.textContent = pieces.join('  •  ')
  } else {
    elements.downloadDetail.textContent = recovering ? 'Retrying this step automatically' : failed ? withoutTrailingPeriod(status.message) : experience.activity
  }

  elements.setupSteps.forEach((element, index) => {
    const done = ready || index < step
    element.classList.toggle('done', done)
    element.classList.toggle('active', !ready && index === step)
  })
}

function render(status) {
  currentStatus = status
  const progress = Number(status.progress || 0)
  const ready = Boolean(status.workspaceReady && status.inferenceReady)
  const failed = status.phase === 'failed'
  const recovering = failed && canRecoverAutomatically(status) && setupRecoveryAttempts < MAX_SETUP_RECOVERY_ATTEMPTS

  if (ready && invoke) {
    if (!workspaceOpened) {
      workspaceOpened = true
      const fresh = freshWorkspaceRequested
      freshWorkspaceRequested = false
      invoke('open_workspace', { fresh }).catch((error) => {
        workspaceOpened = false
        document.body.classList.remove('launch-pending')
        elements.phaseMessage.textContent = withoutTrailingPeriod(error)
        elements.status.classList.add('error')
        elements.status.querySelector('span').textContent = 'Workspace unavailable'
      })
    }
    return
  }

  document.body.classList.remove('launch-pending')

  elements.progress.style.setProperty('--progress', Math.max(0, Math.min(100, progress)))
  elements.progressValue.textContent = `${progress}%`
  elements.phaseMessage.textContent = withoutTrailingPeriod(status.message || 'Waiting for Balto')
  renderJourney(status, progress, ready, failed, recovering)
  elements.status.classList.toggle('ready', ready)
  elements.status.classList.toggle('error', failed && !recovering)

  if (ready) {
    elements.status.querySelector('span').textContent = 'Local stack ready'
    elements.phaseTitle.textContent = 'Balto is ready to work'
    elements.primaryLabel.textContent = 'Open Balto workspace'
  } else if (recovering) {
    elements.status.querySelector('span').textContent = 'Setup is recovering'
    elements.phaseTitle.textContent = 'Balto is finishing setup'
    elements.primaryLabel.textContent = 'Retrying automatically'
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

  elements.primary.disabled = busy || isWorking(status.phase) || recovering
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
    status.workspaceReady ? 'Documents\\Balto is ready' : 'Documents\\Balto with efficient local tool calls',
  )

  elements.warning.hidden = !status.warning || recovering
  elements.warningText.textContent = recovering ? '' : status.warning || ''

  elements.remoteToggle.checked = Boolean(status.remoteEnabled)
  elements.remoteToggle.disabled = !ready || !status.tailscaleInstalled || !status.tailscaleSignedIn || busy || remoteChanging
  if (status.remoteEnabled && status.remoteUrl) {
    elements.remoteDescription.textContent = 'Ready on your tailnet'
    elements.remoteUrl.hidden = false
    elements.remoteUrl.textContent = status.remoteUrl
    elements.remoteUrl.href = status.remoteUrl
  } else {
    elements.remoteUrl.hidden = true
    elements.remoteDescription.textContent = !ready
      ? 'Available after Balto starts'
      : status.tailscaleSignedIn
        ? 'Turn on to create your remote control link'
        : 'Sign this computer into the same tailnet as your remote device'
  }

}

function canRecoverAutomatically(status) {
  if (!invoke || !status.gpuName?.includes('5090')) return false
  if (status.workspaceReady && status.inferenceReady) return false
  if (status.phase === 'not-installed') return true
  if (status.phase === 'failed') return Number(status.progress || 0) < 100
  return ['degraded', 'stopped'].includes(status.phase)
}

function scheduleAutomaticRecovery(status) {
  if (!canRecoverAutomatically(status) || busy || setupRecoveryTimer || setupRecoveryAttempts >= MAX_SETUP_RECOVERY_ATTEMPTS) return
  const delay = status.phase === 'not-installed' ? 250 : Math.min(12000, 1500 * 2 ** setupRecoveryAttempts)
  setupRecoveryAttempts += 1
  setupRecoveryTimer = setTimeout(async () => {
    setupRecoveryTimer = null
    freshWorkspaceRequested = status.phase === 'not-installed' || status.phase === 'failed'
    await runAction('setup_stack')
  }, delay)
}

async function refresh() {
  try {
    const status = invoke ? await invoke('get_status') : previewStatus
    render(status)
    if (status.workspaceReady && status.inferenceReady) {
      setupRecoveryAttempts = 0
      if (setupRecoveryTimer) clearTimeout(setupRecoveryTimer)
      setupRecoveryTimer = null
    } else {
      scheduleAutomaticRecovery(status)
    }
  } catch (error) {
    document.body.classList.remove('launch-pending')
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
  setupRecoveryAttempts = 0
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
