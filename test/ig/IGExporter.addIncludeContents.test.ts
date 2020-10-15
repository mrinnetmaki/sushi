import fs from 'fs-extra';
import path from 'path';
import temp from 'temp';
import { IGExporter } from '../../src/ig';
import { Package } from '../../src/export';
import { loggerSpy } from '../testhelpers/loggerSpy';
import { minimalConfig } from '../utils/minimalConfig';
import { Configuration } from '../../src/fshtypes';
import { cloneDeep } from 'lodash';

describe('IGExporter', () => {
  // Track temp files/folders for cleanup
  temp.track();

  describe('#include-contents', () => {
    let tempOut: string;
    let config: Configuration;
    const outputFileSyncSpy = jest.spyOn(fs, 'outputFileSync');

    beforeEach(() => {
      tempOut = temp.mkdirSync('sushi-test');
      config = cloneDeep(minimalConfig);
      loggerSpy.reset();
    });

    afterEach(() => {
      temp.cleanupSync();
    });

    it('should not copy input/includes files', () => {
      const pkg = new Package(config);
      const igDataPath = path.resolve(__dirname, 'fixtures', 'customized-ig', 'ig-data');
      const exporter = new IGExporter(pkg, null, igDataPath, true); // New tank configuration
      exporter.addIncludeContents(tempOut);
      const includesPath = path.join(tempOut, 'input', 'includes');
      expect(fs.existsSync(includesPath)).toBeFalsy();
      expect(outputFileSyncSpy).not.toHaveBeenCalled();
      expect(loggerSpy.getAllMessages()).toHaveLength(0);
    });

    it('should copy input/includes files with warning in legacy IG publisher configuration', () => {
      const pkg = new Package(config);
      const igDataPath = path.resolve(__dirname, 'fixtures', 'customized-ig', 'ig-data');
      const exporter = new IGExporter(pkg, null, igDataPath); // Legacy tank configuration
      exporter.addIncludeContents(tempOut);
      const includesPath = path.join(tempOut, 'input', 'includes');
      expect(fs.existsSync(includesPath)).toBeTruthy();
      expect(outputFileSyncSpy).toHaveBeenCalledTimes(1);
      const files = fs.readdirSync(includesPath, 'utf8');
      expect(files).toEqual(['other.xml']); // Should include other.xml and not menu.xml since that isn't handle in addIncludeContents()
      const content = fs.readFileSync(path.join(includesPath, 'other.xml'), 'utf8');
      expect(content).toMatch(/^\*\s+WARNING: DO NOT EDIT THIS FILE\s+\*$/m);
      expect(loggerSpy.getAllMessages()).toHaveLength(0);
    });
  });
});
