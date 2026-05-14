# xhs-pictureCut-tool

[中文说明](./README.md)

A lightweight PWA tool for extracting image assets from Xiaohongshu screenshot layouts. After users upload Xiaohongshu screenshots, the server reads pixels with `sharp` and automatically crops the central image area, making it easier to collect reusable visual assets.

## Live URL

```text
https://picture-cut-tool.vercel.app/
```

API endpoint:

```text
https://picture-cut-tool.vercel.app/api/process
```

## Features

- Upload by file picker, drag and drop, or paste
- Process one or multiple screenshots
- Up to 10 images per request, 12MB per image
- Automatically detects and crops the central image area in Xiaohongshu UI screenshots
- Preview, save, or delete each cropped result independently
- Saves recent results in browser IndexedDB
- Keeps IndexedDB results for 10 minutes and clears expired entries automatically
- Supports manual cache clearing
- PWA support for adding the tool to an iPhone home screen
- Light mode and dark mode support
- Images only pass through Vercel Serverless Function memory during request processing; they are not written to a database or long-term server storage

## Local Development

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

Run a production build check:

```bash
npm run build
```

## Cropping Logic

`lib/crop.ts` uses `sharp` to read raw pixel data:

1. Samples the four corners, side edges, top edge, and bottom edge to estimate the background color.
2. Uses RGB Euclidean distance to detect non-background pixels while tolerating near-solid backgrounds.
3. Scans rows and columns to calculate non-background pixel ratios.
4. Smooths row and column ratios to locate a continuous, high-density, sufficiently large subject area.
5. Ignores the top status bar, bottom edge, and tiny text or button regions.
6. Slightly contracts the crop boundary to reduce watermark, border, and scattered-text interference.
7. Falls back to a conservative center crop when automatic detection is uncertain.

The API returns `cropBox`, `confidence`, and basic debug data so the algorithm can be tuned later.

## API

### POST `/api/process`

Request type: `multipart/form-data`

Field name: `images`

The endpoint can be used from iOS Shortcuts, web forms, curl, or other clients. No login or cookie is required.

Example response:

```json
{
  "results": [
    {
      "id": "unique-id",
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

## iOS Shortcuts

You can configure an iOS Shortcut like this:

1. Select photos or receive images from the share sheet.
2. Use "Get Contents of URL".
3. Set URL to:

```text
https://picture-cut-tool.vercel.app/api/process
```

4. Choose `POST` as the method.
5. Choose `Form` as the request body.
6. Add a file field named `images`.
7. Set the field value to the image variable from Shortcuts.
8. The response is JSON; `results[0].dataUrl` contains the cropped image as a base64 data URL.

For multiple images, repeat the same field name `images`.

## Privacy and Disclaimer

This tool only provides screenshot asset extraction. It does not determine copyright ownership, authorization status, or privacy risk. If extracted assets involve the original creator's privacy or related rights, you are responsible for obtaining proper authorization. This tool is not responsible for any infringement or privacy issues caused by its use.

The English disclaimer above was translated by Codex from the Chinese disclaimer and is maintained alongside it.

## Codex Contribution

Codex assisted with the frontend experience, dark mode, motion design, project naming, bilingual README documentation, and English disclaimer translation. Codex also helped with local build checks, Git commit organization, and deployment URL verification.

## Deploying to Vercel

1. Log in to [Vercel](https://vercel.com).
2. Click `Add New Project`.
3. Select the GitHub repository `chips-king/pictureCut-tool`.
4. Choose `Next.js` as the framework preset.
5. Keep the build command as `npm run build`.
6. Keep the output directory as the default.
7. Click Deploy.

The deployed project URL is:

```text
https://picture-cut-tool.vercel.app/
```

After deployment succeeds, the local `npm run dev` process can be stopped. The site runs on Vercel, with no need for a long-running local server, a custom domain, or a separate database.

## Notes

- Vercel Serverless Functions have response-size limits, so very large images or too many images in one request may fail.
- The current API limit is 10 images per request and 12MB per image.
- Output is high-quality JPEG for convenient saving on iOS and the web.
- This project does not provide ZIP batch downloads, user accounts, or long-term image storage.
