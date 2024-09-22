import NuxtOgImage from '../../../src/module'

// https://v3.nuxtjs.org/api/configuration/nuxt.config
export default defineNuxtConfig({
  modules: [
    NuxtOgImage,
  ],
  site: {
    url: 'https://nuxtseo.com',
  },
  ssr: false,
  ogImage: {
    debug: true,
    runtimeBrowser: true,
  },
  routeRules: {
    '/satori/route-rules/**': {
      ogImage: {
        title: 'Hello from route rules',
      },
    },
  },
  devtools: { enabled: false },
})
