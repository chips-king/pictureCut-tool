# xhs-pictureCut-tool

轻量级 PWA 网站，专门为小红书 UI 进行识别截图，方便提取素材。用户上传小红书截图后，服务端使用 `sharp` 读取像素并自动裁切中间图片区域，不引入 OpenCV.js，不长期保存图片。

## 免责声明

提取素材如涉及原作者隐私或相关权益，请自行获得授权；因使用本工具产生的侵权或隐私问题，本工具不承担责任。

生产环境目标域名：

```text
https://pictureCut.vercel.app
```

## 本地运行

先安装依赖：

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

## 功能

- 首页上传截图，支持点击选择和拖拽上传
- 支持单张和多张图片处理
- 每张图片单独显示预览、保存图片、删除按钮
- 多张结果不会互相覆盖
- 最近结果保存到浏览器 IndexedDB
- IndexedDB 结果 TTL 为 10 分钟，过期自动清理
- PWA 支持添加到 iPhone 主屏幕
- 图片只在请求处理中临时进入 Vercel Serverless Function 内存，不写入数据库或长期服务器存储

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
https://pictureCut.vercel.app/api/process
```

4. 方法选择 `POST`。
5. 请求正文选择 `表单`。
6. 添加文件字段，字段名填写 `images`。
7. 字段值选择快捷指令中的图片变量。
8. 返回结果是 JSON，其中 `results[0].dataUrl` 是裁切后的图片 base64 data URL。

多张图片也使用同一个字段名 `images` 重复传入。

## 上传到 GitHub

在项目目录执行：

```bash
git init
git add .
git commit -m "Initial xhs-pictureCut-tool"
git branch -M main
git remote add origin https://github.com/你的用户名/xhs-pictureCut-tool.git
git push -u origin main
```

## 部署到 Vercel

1. 登录 [Vercel](https://vercel.com)。
2. 点击 `Add New Project`。
3. 选择刚上传到 GitHub 的 `xhs-pictureCut-tool` 仓库。
4. Framework Preset 选择 `Next.js`。
5. Build Command 保持 `npm run build`。
6. Output Directory 保持默认。
7. 点击 Deploy。

部署完成后，Vercel 会自动分配一个 HTTPS 域名。你可以在项目的 `Domains` 页面看到自动域名，例如：

```text
https://pictureCut.vercel.app
```

部署成功后，本地的 `npm run dev` 可以关闭。网站运行在 Vercel，不需要长期运行本地服务器，也不需要购买域名、云服务器或数据库。

## 注意事项

- Vercel Serverless Function 有响应体大小限制，特别大的图片或一次上传太多图片时可能失败。
- 当前接口限制一次最多 10 张，每张最多 12MB。
- 输出统一为高质量 JPEG，方便在 iOS 和网页保存。
- 本项目不使用 zip 批量下载，不做账号系统，不长期保存用户图片。
