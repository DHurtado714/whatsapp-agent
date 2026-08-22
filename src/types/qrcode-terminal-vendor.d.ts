declare module 'qrcode-terminal/vendor/QRCode/index.js' {
  class QRCode {
    constructor(typeNumber: number, errorCorrectLevel: number)
    addData(data: string): void
    make(): void
    getModuleCount(): number
    isDark(row: number, col: number): boolean
  }
  export = QRCode
}

declare module 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js' {
  const QRErrorCorrectLevel: { L: number; M: number; Q: number; H: number }
  export = QRErrorCorrectLevel
}
