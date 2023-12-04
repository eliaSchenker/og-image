import * as fs from 'node:fs'
import {
  addComponent,
  addComponentsDir,
  addImports,
  addPlugin,
  addServerHandler,
  addServerPlugin,
  addTemplate,
  createResolver,
  defineNuxtModule,
  hasNuxtModule,
  useLogger,
} from '@nuxt/kit'
import type { SatoriOptions } from 'satori'
import { installNuxtSiteConfig } from 'nuxt-site-config-kit'
import { isDevelopment } from 'std-env'
import { hash } from 'ohash'
import { relative } from 'pathe'
import type { ResvgRenderOptions } from '@resvg/resvg-js'
import type { SharpOptions } from 'sharp'
import { defu } from 'defu'
import { version } from '../package.json'
import type { FontConfig, InputFontConfig, OgImageComponent, OgImageOptions, OgImageRuntimeConfig } from './runtime/types'
import { type RuntimeCompatibilitySchema, getPresetNitroPresetCompatibility, resolveNitroPreset } from './compatibility'
import { extendTypes, getNuxtModuleOptions } from './kit'
import { setupDevToolsUI } from './build/devtools'
import { setupDevHandler } from './build/dev'
import { setupGenerateHandler } from './build/generate'
import { setupPrerenderHandler } from './build/prerender'
import { setupBuildHandler } from './build/build'

export interface ModuleOptions {
  /**
   * Whether the og:image images should be generated.
   *
   * @default true
   */
  enabled: boolean
  /**
   * Default data used within the payload to generate the OG Image.
   *
   * You can use this to change the default template, image sizing and more.
   *
   * @default { component: 'OgImageTemplateFallback', width: 1200, height: 630, cache: true, cacheTtl: 24 * 60 * 60 * 1000 }
   */
  defaults: OgImageOptions
  /**
   * Fonts to use when rendering the og:image.
   *
   * @example ['Roboto:400,700', { path: 'path/to/font.ttf', weight: 400, name: 'MyFont' }]
   */
  fonts: InputFontConfig[]
  /**
   * Options to pass to satori.
   *
   * @see https://github.com/vercel/satori/blob/main/src/satori.ts#L18
   */
  satoriOptions?: Partial<SatoriOptions>
  /**
   * Options to pass to resvg.
   *
   * @see https://github.com/yisibl/resvg-js/blob/main/wasm/index.d.ts#L39
   */
  resvgOptions?: Partial<ResvgRenderOptions>
  /**
   * Options to pass to sharp.
   *
   * @see https://sharp.pixelplumbing.com/api-constructor
   */
  sharpOptions?: Partial<SharpOptions>
  /**
   * Include Satori runtime.
   *
   * @default true
   */
  runtimeSatori: boolean
  /**
   * Include the Browser runtime.
   * This will need to be manually enabled for production environments.
   *
   * @default `process.dev`
   */
  runtimeChromium: boolean
  /**
   * Enables debug logs and a debug endpoint.
   *
   * @false false
   */
  debug: boolean
  /**
   * Modify the cache behavior.
   *
   * Passing a boolean will enable or disable the runtime cache with the default options.
   *
   * Providing a record will allow you to configure the runtime cache fully.
   *
   * @default true
   * @see https://nitro.unjs.io/guide/storage#mountpoints
   * @example { driver: 'redis', host: 'localhost', port: 6379, password: 'password' }
   */
  runtimeCacheStorage: boolean | (Record<string, any> & {
    driver: string
  })
  /**
   * Extra component directories that should be used to resolve components.
   *
   * @default ['OgImage', 'OgImageTemplate']
   */
  componentDirs: string[]
  /**
   * Manually modify the deployment compatibility.
   */
  runtimeCompatibility?: RuntimeCompatibilitySchema
}
export interface ModuleHooks {
  'nuxt-og-image:components': (ctx: { components: OgImageComponent[] }) => Promise<void> | void
  'og-image:config': (config: ModuleOptions) => Promise<void> | void
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: 'nuxt-og-image',
    compatibility: {
      nuxt: '^3.8.2',
      bridge: false,
    },
    configKey: 'ogImage',
  },
  defaults(nuxt) {
    return {
      enabled: true,
      defaults: {
        emojis: 'noto',
        renderer: 'satori',
        component: 'NuxtSeo',
        width: 1200,
        height: 600,
        // default is to cache the image for 1 day (24 hours)
        cacheMaxAgeSeconds: 60 * 60 * 24 * 3,
      },
      componentDirs: ['OgImage', 'OgImageTemplate'],
      fonts: [],
      runtimeCacheStorage: true,
      runtimeSatori: true,
      runtimeChromium: nuxt.options.dev,
      debug: isDevelopment,
    }
  },
  async setup(config, nuxt) {
    const logger = useLogger('nuxt-og-image')
    logger.level = (config.debug || nuxt.options.debug) ? 4 : 3
    if (config.enabled === false) {
      logger.debug('The module is disabled, skipping setup.')
      return
    }
    if (config.enabled && !nuxt.options.ssr) {
      logger.warn('Nuxt OG Image is enabled but SSR is disabled.\n\nYou should enable SSR (`ssr: true`) or disable the module (`ogImage: { enabled: false }`).')
      return
    }

    const { resolve } = createResolver(import.meta.url)

    const preset = resolveNitroPreset(nuxt.options.nitro)
    const compatibility = getPresetNitroPresetCompatibility(preset)
    const userConfiguredExtension = config.defaults.extension
    config.defaults.extension = userConfiguredExtension || 'jpg'
    if (!compatibility.bindings.sharp && config.defaults.renderer !== 'chromium') {
      if (userConfiguredExtension && ['jpeg', 'jpg'].includes(userConfiguredExtension))
        logger.warn('The sharp runtime is not available for this target, disabling sharp and using png instead.')

      config.defaults.extension = 'png'
    }

    if (config.runtimeChromium && !compatibility.bindings.chromium) {
      logger.warn('The Chromium runtime is not available for this target, disabling runtimeChromium.')
      config.runtimeChromium = false
    }

    // TODO use png if if weren't not using a node-based env

    await installNuxtSiteConfig()

    // convert ogImage key to head data
    if (hasNuxtModule('@nuxt/content'))
      addServerPlugin(resolve('./runtime/nitro/plugins/nuxt-content'))

    if (preset !== 'stackblitz' && config.fonts) {
      // check if any of the fonts are missing paths
      config.fonts = config.fonts.map((f) => {
        if (typeof f === 'string' || !f.path) {
          logger.warn(`Google Fonts are not available in StackBlitz, please use a local font.`)
          return false
        }
        return f
      }).filter(Boolean)
    }
    else {
      // default font is inter
      if (!config.fonts.length)
        config.fonts = ['Inter:400', 'Inter:700']
    }

    nuxt.options.experimental.componentIslands = true

    addServerHandler({
      lazy: true,
      route: '/__og-image__/font/**',
      handler: resolve('./runtime/server/routes/__og-image__/font-[name]-[weight].[extension]'),
    })
    if (config.debug || nuxt.options.dev) {
      addServerHandler({
        lazy: true,
        route: '/__og-image__/debug.json',
        handler: resolve('./runtime/server/routes/__og-image__/debug.json'),
      })
    }
    addServerHandler({
      lazy: true,
      route: '/__og-image__/image/**',
      handler: resolve('./runtime/server/routes/__og-image__/image'),
    })

    nuxt.options.optimization.treeShake.composables.client['nuxt-og-image'] = []
    ;['defineOgImage', 'defineOgImageComponent', 'defineOgImageScreenshot']
      .forEach((name) => {
        addImports({
          name,
          from: resolve(`./runtime/composables/${name}`),
        })
        nuxt.options.optimization.treeShake.composables.client['nuxt-og-image'].push(name)
      })

    await addComponentsDir({
      path: resolve('./runtime/components/Templates/Community'),
      island: true,
      watch: true,
    })

    ;[
      // new
      'OgImage',
      'OgImageScreenshot',
    ]
      .forEach((name) => {
        addComponent({
          name,
          global: true,
          filePath: resolve(`./runtime/components/OgImage/${name}`),
        })
      })

    // allows us to add og images using route rules without calling defineOgImage
    addPlugin({ mode: 'server', src: resolve('./runtime/nuxt/plugins/route-rule-og-image.server') })
    addPlugin({ mode: 'server', src: resolve('./runtime/nuxt/plugins/og-image-canonical-urls.server') })

    // we're going to expose the og image components to the ssr build so we can fix prop usage
    const ogImageComponentCtx: { components: OgImageComponent[] } = { components: [] }
    nuxt.hook('components:extend', (components) => {
      ogImageComponentCtx.components = []
      const validComponents: typeof components = []
      // check if the component folder starts with OgImage or OgImageTemplate and set to an island component
      components.forEach((component) => {
        let valid = false
        config.componentDirs.forEach((dir) => {
          if (component.pascalName.startsWith(dir) || component.kebabName.startsWith(dir)
            // support non-prefixed components
            || component.shortPath.includes(`/${dir}/`))
            valid = true
        })
        if (component.filePath.includes(resolve('./runtime/components/Templates')))
          valid = true

        if (valid && fs.existsSync(component.filePath)) {
          // get hash of the file
          component.island = true
          component.mode = 'server'
          validComponents.push(component)
          let category: OgImageComponent['category'] = 'app'
          if (component.filePath.includes(resolve('./runtime/components/Templates/Community')))
            category = 'community'
          const componentFile = fs.readFileSync(component.filePath, 'utf-8')
          // see if we can extract credits from the component file, just find the line that starts with * @credits and return the rest of the line
          const credits = componentFile.split('\n').find(line => line.startsWith(' * @credits'))?.replace('* @credits', '').trim()
          ogImageComponentCtx.components.push({
            // purge cache when component changes
            hash: hash(componentFile),
            pascalName: component.pascalName,
            kebabName: component.kebabName,
            path: nuxt.options.dev ? component.filePath : undefined,
            category,
            credits,
          })
        }
      })
      // TODO add hook and types
      // @ts-expect-error untyped
      nuxt.hooks.hook('nuxt-og-image:components', ogImageComponentCtx)
    })
    addTemplate({
      filename: 'og-image-component-names.mjs',
      getContents() {
        return `export const componentNames = ${JSON.stringify(ogImageComponentCtx.components)}`
      },
      options: { mode: 'server' },
    })
    nuxt.options.nitro.virtual = nuxt.options.nitro.virtual || {}
    nuxt.options.nitro.virtual['#nuxt-og-image/component-names.mjs'] = () => {
      return `export const componentNames = ${JSON.stringify(ogImageComponentCtx.components)}`
    }

    // support simple theme extends
    let unoCssConfig: any = { theme: {} }
    nuxt.hook('tailwindcss:config', (tailwindConfig) => {
      // @ts-expect-error untyped
      unoCssConfig = defu(tailwindConfig.theme.extend, { ...(tailwindConfig.theme || {}), extend: undefined })
    })
    // @ts-expect-error runtime type
    nuxt.hook('unocss:config', (_unoCssConfig) => {
      unoCssConfig = { ..._unoCssConfig.theme }
    })
    nuxt.options.nitro.virtual['#nuxt-og-image/unocss-config.mjs'] = () => {
      return `export const theme = ${JSON.stringify(unoCssConfig)}`
    }

    extendTypes('nuxt-og-image', ({ typesPath }) => {
      // need to map our components to types so we can import them
      const componentImports = ogImageComponentCtx.components.map((component) => {
        const relativeComponentPath = relative(resolve(nuxt!.options.rootDir, nuxt!.options.buildDir, 'module'), component.path!)
        return `    '${component.pascalName}': typeof import('${relativeComponentPath}')['default']`
      }).join('\n')
      return `
declare module 'nitropack' {
  interface NitroRouteRules {
    ogImage?: false | import('${typesPath}').OgImageOptions & Record<string, any>
  }
  interface NitroRouteConfig {
    ogImage?: false | import('${typesPath}').OgImageOptions & Record<string, any>
  }
}

declare module '#nuxt-og-image/components' {
  export interface OgImageComponents {
${componentImports}
  }
}
`
    })

    const cacheEnabled = typeof config.runtimeCacheStorage !== 'undefined' && config.runtimeCacheStorage !== false
    const runtimeCacheStorage = typeof config.runtimeCacheStorage === 'boolean' ? 'default' : config.runtimeCacheStorage.driver
    let baseCacheKey: string | false = runtimeCacheStorage === 'default' ? `/cache/nuxt-og-image@${version}` : `/nuxt-og-image@${version}`
    if (!cacheEnabled)
      baseCacheKey = false

    nuxt.hooks.hook('modules:done', async () => {
      // allow other modules to modify runtime data
      // @ts-expect-error untyped
      nuxt.hooks.callHook('og-image:config', config)
      const normalisedFonts: FontConfig[] = config.fonts.map((f) => {
        if (typeof f === 'string') {
          const [name, weight] = f.split(':')
          return <FontConfig>{
            name,
            weight,
            path: undefined,
          }
        }
        return f as FontConfig
      })
      if (!nuxt.options._generate && nuxt.options.build) {
        nuxt.options.nitro.prerender = nuxt.options.nitro.prerender || {}
        nuxt.options.nitro.prerender.routes = nuxt.options.nitro.prerender.routes || []
        normalisedFonts
          // if they have a path we can always access them locally
          .filter(f => !f.path)
          .forEach(({ name, weight }) => {
            nuxt.options.nitro.prerender!.routes!.push(`/__og-image__/font/${name}/${weight}.ttf`)
          })
      }

      // set theme color for the NuxtSeo component
      let colorPreference = hasNuxtModule('@nuxtjs/color-mode')
        ? (await getNuxtModuleOptions('@nuxtjs/color-mode') as { preference?: 'light' | 'dark' | 'system' }).preference
        : 'light'
      if (!colorPreference || !['dark', 'light'].includes(colorPreference))
        colorPreference = 'light'

      // @ts-expect-error runtime types
      nuxt.options.runtimeConfig['nuxt-og-image'] = <OgImageRuntimeConfig> {
        version,
        // binding options
        satoriOptions: config.satoriOptions || {},
        resvgOptions: config.resvgOptions || {},
        sharpOptions: config.sharpOptions || {},

        runtimeSatori: config.runtimeSatori,
        runtimeChromium: config.runtimeChromium,
        defaults: config.defaults,
        debug: config.debug,
        // avoid adding credentials
        baseCacheKey,
        // convert the fonts to uniform type to fix ts issue
        fonts: normalisedFonts,
        hasNuxtIcon: hasNuxtModule('nuxt-icon'),
        colorPreference,
      }
    })

    // Setup playground. Only available in development
    if (nuxt.options.dev) {
      setupDevHandler(config, resolve)
      setupDevToolsUI(config, resolve)
    }
    else if (nuxt.options._generate) {
      setupGenerateHandler(config, resolve)
    }
    else if (nuxt.options.build) {
      await setupBuildHandler(config, resolve)
    }
    // if prerendering
    if (nuxt.options.nitro.prerender?.routes?.length || nuxt.options.nitro.prerender?.crawlLinks || nuxt.options._generate)
      addServerPlugin(resolve('./runtime/nitro/plugins/prerender.ts'))
    // always call this as we may have routes only discovered at build time
    setupPrerenderHandler(config, resolve)
  },
})
