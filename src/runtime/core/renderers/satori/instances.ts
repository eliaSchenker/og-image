import type _sharp from 'sharp'
import type { Resvg } from '@resvg/resvg-wasm'
import type _satori from 'satori'

// we keep instances alive to avoid re-importing them on every request, maybe not needed but
// also helps with type inference

const sharpInstance: { instance?: typeof _sharp } = { instance: undefined }
const resvgInstance: { instance?: { initWasmPromise: Promise<void>, Resvg: typeof Resvg } } = { instance: undefined }
const satoriInstance: { instance?: { initWasmPromise: Promise<void>, satori: typeof _satori } } = { instance: undefined }

export async function useResvg() {
  resvgInstance.instance = resvgInstance.instance || await import('#nuxt-og-image/bindings/resvg').then(m => m.default)
  await resvgInstance.instance!.initWasmPromise
  return resvgInstance.instance!.Resvg
}

export async function useSatori() {
  satoriInstance.instance = satoriInstance.instance || await import('#nuxt-og-image/bindings/satori').then(m => m.default)
  await satoriInstance.instance!.initWasmPromise
  return satoriInstance.instance!.satori
}

export async function useSharp() {
  sharpInstance.instance = sharpInstance.instance || await import('#nuxt-og-image/bindings/sharp').then(m => m.default)
  return sharpInstance.instance!
}
