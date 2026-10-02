/**
 * Vite / 打包环境类型声明（UI01 自有）。
 * 只声明 CSS 副作用导入与静态资源；不引入 vite/client 以免与根工具链耦合。
 */
declare module '*.css' {
  const content: string;
  export default content;
}

declare module '*.svg' {
  const content: string;
  export default content;
}
