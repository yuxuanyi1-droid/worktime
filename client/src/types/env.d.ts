/**
 * Vite 构建期注入的全局常量（见 vite.config.ts 的 define）。
 * 用于子路径部署（BASE_PATH，如 /worktime），与根路径部署（空）兼容。
 *
 * - __BASE_PATH__：子路径前缀，无尾斜杠（如 '/worktime'，根路径部署为 ''）。
 *                  用于 axios baseURL、BrowserRouter basename、分享链接拼接。
 * - __BASE_URL__ ：带尾斜杠的形式（如 '/worktime/'，根路径部署为 '/'）。
 *                  用于整页跳转（window.location.href）。
 */
declare const __BASE_PATH__: string;
declare const __BASE_URL__: string;
