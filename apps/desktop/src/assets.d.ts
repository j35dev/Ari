/** Vite resolves asset imports (bundled wallpapers) at build time; TS just needs the shape. */
declare module '*.jpg' {
  const src: string
  export default src
}
