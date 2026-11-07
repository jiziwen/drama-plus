# 正式导演界面资源

- `starfield.js`、`ribbon.js`、`cinema.js`、`cinema.css` 从本项目已验收的概念界面实现迁入，作为正式业务资源维护。
- 正式模块仅使用本目录相对导入，不依赖 `public/preview/`。
- `vendor/` 包含 Three.js、本地字体和原许可文件；资源无需外部 CDN。
- `assets/empty-screen.svg` 为视频载入时的纯色占位；`story-placeholder.svg` 为无封面或新项目的中性插画。均不表示已生成素材。
- 业务项目、镜头与媒体来自原 API；本目录没有示例项目 store。
