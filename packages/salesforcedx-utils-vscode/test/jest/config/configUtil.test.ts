import { ConfigUtil } from '../../../src';

describe('ConfigUtil', () => {
  describe('getProjectPackageNames', () => {
    it('should return project package directories listed in project config file', () => {
      const a = ConfigUtil.getProjectPackageNames();

      expect(a).toEqual('');
    });
  });
});
