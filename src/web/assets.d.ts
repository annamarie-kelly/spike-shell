// esbuild's dataurl loader turns .png imports into data-URI strings (see the
// `loader` option in build.mjs / build-web.mjs); this teaches tsc the same.
declare module '*.png' {
  const dataUri: string;
  export default dataUri;
}
