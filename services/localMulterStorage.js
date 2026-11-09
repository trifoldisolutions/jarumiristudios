// Local-disk multer storage engine used when STORAGE_BACKEND=local (see .env) — lets dev work
// without real R2 credentials/network access. Mirrors r2MulterStorage's _handleFile/_removeFile
// callback shape ({ filename, storedName, size, backend, buffer? }) so route handlers and
// redirectToStoredFile/moveStoredFile in services/storage.js don't need to know which engine wrote a file.
// Files land under uploads/<prefix>/<folder>/<storedName>, matching r2MulterStorage's key shape.
const fs = require("fs");
const path = require("path");
const { PassThrough } = require("stream");
const { uniqueFilename, fileTypeFromMime } = require("./uploadUtils");

function createLocalStorage(getPrefix = (req) => req.crCode, getFolder = (req, file) => fileTypeFromMime(file.mimetype)) {
  return {
    _handleFile(req, file, cb) {
      const storedName = uniqueFilename(file.originalname);
      const dir = path.join(__dirname, "..", "uploads", getPrefix(req), getFolder(req, file));
      fs.mkdirSync(dir, { recursive: true });
      const destPath = path.join(dir, storedName);
      const isImage = /^image\//i.test(file.mimetype);

      // Images are buffered in memory (same as the R2 engine) so the same buffer can feed
      // sharp() for the blur preview in the upload-completion handlers, instead of re-reading
      // the file back off disk.
      if (isImage) {
        const chunks = [];
        file.stream.on("error", cb);
        file.stream.on("data", (chunk) => chunks.push(chunk));
        file.stream.on("end", () => {
          const buffer = Buffer.concat(chunks);
          fs.writeFile(destPath, buffer, (err) => {
            if (err) return cb(err);
            cb(null, { filename: storedName, storedName, backend: "local", size: buffer.length, buffer });
          });
        });
        return;
      }

      let size = 0;
      const counter = new PassThrough();
      file.stream.on("error", cb);
      file.stream.on("data", (chunk) => { size += chunk.length; });
      file.stream.pipe(counter);
      const writeStream = fs.createWriteStream(destPath);
      writeStream.on("error", cb);
      writeStream.on("finish", () => cb(null, { filename: storedName, storedName, backend: "local", size }));
      counter.pipe(writeStream);
    },

    _removeFile(req, file, cb) {
      const dir = path.join(__dirname, "..", "uploads", getPrefix(req), getFolder(req, file));
      fs.unlink(path.join(dir, file.storedName), () => cb(null));
    },
  };
}

module.exports = { createLocalStorage };
