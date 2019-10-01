# @percy/appium-wd

[![Package Status](https://img.shields.io/npm/v/@percy/appium-wd.svg)](https://www.npmjs.com/package/@percy/appium-wd)

[Percy](https://percy.io) visual testing for [Appium](https://appium.io)
and [Webdriver.](https://www.seleniumhq.org/projects/webdriver/)


## Quick start

Assuming you have an existing Appium setup using Webdriver:

- Install the `@percy/appium-wd` package: `yarn add -D @percy/appium-wd` or `npm
i -D @percy/appium-wd`
- `import` or `require` the SDK into the test suite (this can be done in a setup
file or anywhere before the tests start): `import '@percy/appium-wd';` or
`require('@percy/appium-wd');`
- Call `await driver.percySnapshot('snapshot name')` in your tests (for
  example):
```js
test('Percy works', async () => {
  await driver.percySnapshot('test');
});
```

- Finally, when running your tests, wrap the test command with `percy exec`. For
  example: `percy exec -- jest`. Be sure your `PERCY_TOKEN` is set in the
  terminal you're running `percy exec` from (you can get your `PERCY_TOKEN` from
  your Percy projects settings).
