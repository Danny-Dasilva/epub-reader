declare module 'sbd' {
  interface Options {
    newline_boundaries?: boolean;
    html_boundaries?: boolean;
    sanitize?: boolean;
    allowed_tags?: string[] | boolean;
    abbreviations?: string[];
  }

  function sentences(text: string, options?: Options): string[];

  const tokenizer: { sentences: typeof sentences };
  export default tokenizer;
  export { sentences };
}
