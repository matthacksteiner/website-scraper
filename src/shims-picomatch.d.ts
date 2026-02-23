declare module 'picomatch' {
  type Matcher = (input: string) => boolean;
  function picomatch(pattern: string): Matcher;
  export default picomatch;
}
