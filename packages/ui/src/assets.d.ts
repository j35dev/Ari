/** Vite resolves asset imports (wallpapers) at build time; TS just needs the shape. */
declare module '*.jpg' {
  const src: string
  export default src
}

/** Side-effect CSS packages (fonts.ts); they ship stylesheets, not types. */
declare module '@fontsource-variable/geist'
declare module '@fontsource-variable/geist-mono'
