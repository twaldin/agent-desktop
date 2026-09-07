import {expect,test} from 'bun:test';
import {assertMarketplaceGitSource,parseMarketplaceSourceOptions} from './plugin-acquisition';
test('source options retain exact literal paths and reject unsafe or malformed fields',()=>{
 const input={ref:'release/selected',sparsePaths:['plugins/a','literal[1].txt','folder with spaces/file.txt']};const parsed=parseMarketplaceSourceOptions(input);expect(parsed).toEqual(input);parsed.sparsePaths!.push('new');expect(input.sparsePaths).toHaveLength(3);
 for(const value of [null,[],{other:true},{ref:'--upload-pack=x'},{ref:'x\ny'},{ref:''},{ref:'main~1'},{ref:'bad..ref'},{ref:'x:y'},{sparsePaths:['/root']},{sparsePaths:['x/../y']},{sparsePaths:['.git/config']},{sparsePaths:['x\\y']},{sparsePaths:['x\ny']},{sparsePaths:Array(129).fill('x')},{sparsePaths:[123]}])expect(()=>parseMarketplaceSourceOptions(value)).toThrow();
 expect(parseMarketplaceSourceOptions({})).toEqual({});expect(parseMarketplaceSourceOptions({ref:'a'.repeat(40)})).toEqual({ref:'a'.repeat(40)});
});

test('Git-only options reject local and JSON sources before native admission',()=>{
 for(const source of ['owner/repo','git@host:repo','ssh://host/repo','https://host/repo.git','https://host/repo'])expect(()=>assertMarketplaceGitSource(source)).not.toThrow();
 for(const source of ['/tmp/repository','./repository','owner_name/repo','owner.name/repo','https://host/catalog.json?x=1','https://',''])expect(()=>assertMarketplaceGitSource(source)).toThrow('Git ref and sparse paths require a Git repository source');
});
