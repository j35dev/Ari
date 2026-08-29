/** Vite resolves asset imports (wallpapers) at build time; TS just needs the shape. */
declare module '*.jpg' {
  const src: string
  export default src
}
