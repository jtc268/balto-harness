import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const [settingsPath, templatePath, yamlModulePath] = process.argv.slice(2)
if (!settingsPath || !templatePath || !yamlModulePath) {
  throw new Error('usage: configure-settings.mjs <settings> <template> <js-yaml-module>')
}

const yaml = await import(pathToFileURL(yamlModulePath).href)
const template = yaml.load(await readFile(templatePath, 'utf8'))
let settings
try {
  settings = yaml.load(await readFile(settingsPath, 'utf8'))
} catch (error) {
  if (error.code !== 'ENOENT') throw error
  settings = {}
}

settings ||= {}
settings['agent-default-model'] ||= template['agent-default-model']
settings.permission ||= template.permission
settings['agent-presets'] ||= {}
settings['agent-presets'].default = template['agent-presets'].default
settings['llm-pi-ai'] ||= {}
settings['llm-pi-ai'].providers ||= {}

const managedProvider = template['llm-pi-ai'].providers.sglang
const currentProvider = settings['llm-pi-ai'].providers.sglang || {}
const currentModels = Array.isArray(currentProvider.models) ? currentProvider.models : []
const managedModel = managedProvider.models[0]
const managedModelIndex = currentModels.findIndex((model) => model?.id === managedModel.id)
const models = [...currentModels]
if (managedModelIndex === -1) models.unshift(managedModel)
else models[managedModelIndex] = { ...models[managedModelIndex], ...managedModel }

settings['llm-pi-ai'].providers.sglang = {
  ...currentProvider,
  ...managedProvider,
  models,
}

await writeFile(settingsPath, yaml.dump(settings, { lineWidth: 120, noRefs: true }), 'utf8')
