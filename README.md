# xhs-pictureCut-tool

[English README](./README.en.md)

一个面向小红书截图的轻量级 PWA 工具。上传小红书截图后，服务端使用 `sharp` 读取像素并自动裁切中间图片区域，方便快速提取截图里的素材图片。

## 在线地址

```text
https://picture-cut-tool.vercel.app/
```

API 地址：

```text
https://picture-cut-tool.vercel.app/api/process
```

## 功能

- 支持点击选择、拖拽上传和粘贴上传图片
- 支持单张或多张截图处理
- 一次最多处理 10 张图片，每张最大 12MB
- 自动识别小红书 UI 中间图片区域并裁切
- 每张结果单独显示预览、保存图片、删除按钮
- 最近结果保存到浏览器 IndexedDB
- IndexedDB 结果保留 10 分钟，过期自动清理
- 支持清空缓存
- 支持 PWA，可添加到 iPhone 主屏幕
- 支持浅色模式和深色模式
- 图片只在请求处理中临时进入 Vercel Serverless Function 内存，不写入数据库或长期服务器存储

## 本地运行

安装依赖：

```bash
npm install
```

启动开发环境：

```bash
npm run dev
```

打开：

```text
http://localhost:3000
```

构建检查：

```bash
npm run build
```

## 裁切逻辑

`lib/crop.ts` 使用 `sharp` 获取 raw 像素数据：

1. 从四角、左右边缘、顶部边缘、底部边缘采样，估计背景色。
2. 使用 RGB 欧氏距离判断非背景像素，容忍近似纯色背景。
3. 分别扫描行和列，统计非背景像素比例。
4. 平滑行列比例，寻找连续、高占比、尺寸足够大的主体区域。
5. 忽略顶部状态栏、底部边缘以及过小文字按钮区域。
6. 对边界做轻微内缩，减少水印、边框或零散文字干扰。
7. 自动识别失败时使用保守中心裁切兜底。

接口返回 `cropBox`、`confidence` 和基础 debug 信息，方便后续调整算法。

## API

### POST `/api/process`

请求类型：`multipart/form-data`

字段名：`images`

支持 iOS 快捷指令、网页表单、curl 等方式上传。不需要登录，不需要 cookie。

返回示例：

```json
{
  "results": [
    {
      "id": "唯一id",
      "filename": "IMG_0001.PNG",
      "mime": "image/jpeg",
      "width": 1080,
      "height": 1440,
      "dataUrl": "data:image/jpeg;base64,...",
      "cropBox": {
        "left": 0,
        "top": 0,
        "width": 1080,
        "height": 1440
      },
      "confidence": 0.95
    }
  ]
}
```

## iOS 快捷指令调用

快捷指令可按这个流程配置：

1. 选择照片或接收共享表单中的图片。
2. 使用“获取 URL 内容”。
3. URL 填写：

```text
https://picture-cut-tool.vercel.app/api/process
```

4. 方法选择 `POST`。
5. 请求正文选择 `表单`。
6. 添加文件字段，字段名填写 `images`。
7. 字段值选择快捷指令中的图片变量。
8. 返回结果是 JSON，其中 `results[0].dataUrl` 是裁切后的图片 base64 data URL。

多张图片也使用同一个字段名 `images` 重复传入。

## 隐私与免责声明

本工具只提供截图素材提取能力，不会判断素材的版权归属、授权状态或隐私风险。提取素材如涉及原作者隐私或相关权益，请自行获得授权；因使用本工具产生的侵权或隐私问题，本工具不承担责任。

英文免责声明由 Codex 翻译并同步维护在 [README.en.md](./README.en.md) 中。

## Codex 贡献

本项目的前端体验、深色模式、动效、项目命名、README 中英文文档和免责声明英文翻译由 Codex 协助完成。Codex 也参与了本地构建检查、Git 提交整理和部署 URL 核验。

## 部署到 Vercel

1. 登录 [Vercel](https://vercel.com)。
2. 点击 `Add New Project`。
3. 选择 GitHub 仓库 `chips-king/pictureCut-tool`。
4. Framework Preset 选择 `Next.js`。
5. Build Command 保持 `npm run build`。
6. Output Directory 保持默认。
7. 点击 Deploy。

部署完成后，项目地址为：

```text
https://picture-cut-tool.vercel.app/
```

部署成功后，本地的 `npm run dev` 可以关闭。网站运行在 Vercel，不需要长期运行本地服务器，也不需要购买域名、云服务器或数据库。

## 注意事项

- Vercel Serverless Function 有响应体大小限制，特别大的图片或一次上传太多图片时可能失败。
- 当前接口限制一次最多 10 张，每张最多 12MB。
- 输出统一为高质量 JPEG，方便在 iOS 和网页保存。
- 本项目不使用 zip 批量下载，不做账号系统，不长期保存用户图片。
