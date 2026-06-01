declare module 'bash-parser' {
  function parse(src: string, options?: Record<string, unknown>): unknown
  export = parse
}
