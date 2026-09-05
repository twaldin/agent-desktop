// Isolated process fixture: represents an independent desktop's module-local queue.
import { requestImageAttachment, requestTranscriptImage } from "../attachment-transport";
const endpoint = { origin: process.argv[2]!, hostId: "owner", token: "isolated-download-fixture" };
const images = JSON.parse(process.argv[3]!) as Array<{ sha256: string }>;
const results = await Promise.all(images.map((image, index) => index % 2
  ? requestTranscriptImage(endpoint, "fixture-session", String(index), 1)
  : requestImageAttachment(endpoint, image.sha256)));
console.log(JSON.stringify(results.map(image => ({ sha256: image.sha256, bytes: image.bytes }))));
