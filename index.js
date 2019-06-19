const fs = require("fs");
const jsdom = require("jsdom");
const path = require("path");
const PercyAgent = require("@percy/agent").default;
const slug = require("slug");
const { Webdriver } = require("wd");

// Webdriver extension for taking Percy snapshots
//
// Usage:
//   driver.percySnapshot('My Snapshot');
Webdriver.prototype.percySnapshot = async function percySnapshot(name) {
  // Uncomment this section to append the device name to the snapshot name
  // const capabilities = await this.sessionCapabilities();
  // name = `${name} [${capabilities.deviceName}]`;

  // Get the dimensions of the device so we can render the screenshot
  // at the correct size
  const dimensions = await this.getWindowSize();

  // Get the base64-encoded screenshot of the app
  const rawBase64Data = await this.takeScreenshot();

  // Strip out the spaces and newlines from the raw screenshot response
  const base64Data = rawBase64Data.replace(/([ \r\n]+)/g, "");

  // Create styles for a DOM element that will render the screenshot
  const css = `
    background-image: url('data:image/png;base64,${base64Data}');
    background-repeat: no-repeat;
    background-size: contain;
    height: ${dimensions.height}px;
    width: ${dimensions.width}px;
  `;

  // Percy Agent and JSDOM don't play nicely together if you try to use a
  // <style> tag in the document, but using inline styles seems to work
  const inlineStyle = css.replace(/([\s]*)\n([\s]*)/g, "");

  // Create a fake HTML document that just renders a single DOM node with
  // the screenshot
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>${name}</title>
      </head>
      <body style="margin: 0;">
        <div style="${inlineStyle}"></div>
      </body>
    </html>
  `;

  // Wrap the HTML in JSDOM
  const dom = new jsdom.JSDOM(html, {
    // The URL must be set or the Percy agent uploading it will fail
    url: "http://localhost"
  });

  const percyClient = new PercyAgent({
    clientInfo: "@percy/appium" // TODO
  });

  // Upload the fake document to Percy
  percyClient.snapshot(name, {
    document: dom.window.document,
    minHeight: dimensions.height,
    widths: [dimensions.width]
  });

  // In debug mode, write the document to disk locally
  if (process.env.LOG_LEVEL === "debug") {
    writePercyDebugSnapshot(name, dom.window.document);
  }
};

function writePercyDebugSnapshot(name, document) {
  const rootDir = path.join(__dirname, "..", "..");
  const percyDebugDir = path.join(rootDir, ".percy-debug");

  if (!fs.existsSync(percyDebugDir)) {
    fs.mkdirSync(percyDebugDir);
  }

  const snapshotPath = path.join(percyDebugDir, `${slug(name)}.html`);
  fs.writeFileSync(
    snapshotPath,
    document.documentElement && document.documentElement.outerHTML
  );
  console.log(`Percy debug snapshot written to ${snapshotPath}`);
}
