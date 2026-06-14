declare module 'adm-zip' {
  interface ZipEntry {
    entryName: string;
    isDirectory: boolean;
    getData(): Buffer;
  }

  class AdmZip {
    constructor(data?: Buffer);
    getEntries(): ZipEntry[];
  }

  export default AdmZip;
}
