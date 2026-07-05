---
"@nike-release-checker/sdk": patch
---

Support video-variant `coverCard` properties in `ProductFeedSchema` to handle Nike product feed responses (e.g. NL) where the cover card is a video card with `startImage`, `videoId`, `manifestURL`, and a differently-shaped `portrait`, instead of the previously assumed image-only card shape
