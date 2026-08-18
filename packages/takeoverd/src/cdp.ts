// packages/takeoverd/src/cdp.ts
// Optional CDP bridge to a local Chrome (--remote-debugging-port=9222).
// Degrades to "unavailable" when Chrome is not running — never crashes the daemon.
export interface CdpChannel {
  available(): Promise<boolean>;
  open(url: string): Promise<string>; // returns page title or error string
  snapshot(): Promise<string>;        // simplified DOM text snapshot
}
export class NullCdp implements CdpChannel {
  async available(): Promise<boolean> { return false; }
  async open(): Promise<string> { return "cdp-unavailable"; }
  async snapshot(): Promise<string> { return "cdp-unavailable"; }
}
export class PuppeteerCdp implements CdpChannel {
  private browser: any = null;
  async available(): Promise<boolean> {
    try {
      const puppeteer = await import("puppeteer-core");
      this.browser = await puppeteer.default.connect({ browserURL: "http://127.0.0.1:9222", defaultViewport: null });
      return true;
    } catch { return false; }
  }
  async open(url: string): Promise<string> {
    if (!this.browser) return "cdp-unavailable";
    const page = await this.browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return await page.title();
  }
  async snapshot(): Promise<string> {
    if (!this.browser) return "cdp-unavailable";
    const pages = await this.browser.pages();
    const page = pages[pages.length - 1];
    return await page.evaluate(() => document.body?.innerText.slice(0, 4000) ?? "");
  }
}
