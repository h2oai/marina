// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Independent functional cases for generated code. Kept outside the agent workspace. */
export function retryAfterGraderSource(modulePath: string) {
  return `import {strict as assert} from 'node:assert';
import {parseRetryAfter} from ${JSON.stringify(modulePath)};
const now=Date.parse('Wed, 21 Oct 2015 07:27:00 GMT');
const cases=[['120',120000],[' 2 ',2000],['0',0],['0002',2000],['Wed, 21 Oct 2015 07:28:00 GMT',60000],['Wed, 21 Oct 2015 07:26:00 GMT',0],['Wed, 21 Oct 2015 07:27:00 GMT',0],['nonsense',null],[null,null],[2,null],[{},null],[[],null],[undefined,null],['',null],['   ',null],['1.5',null],['-1',null],['+2',null],['1e3',null],['0x10',null],['Infinity',null],['NaN',null],['9'.repeat(400),null],[String(Number.MAX_SAFE_INTEGER),null]];
let checks=0;
for(const [value,expected] of cases){assert.equal(parseRetryAfter(value,now),expected,String(value));checks++;}
for(const invalidNow of [NaN,Infinity,-Infinity]) for(const value of ['120','Wed, 21 Oct 2015 07:28:00 GMT']){assert.equal(parseRetryAfter(value,invalidNow),null);checks++;}
for(const seconds of [1,7,59,60,999,3600,86400,604800]){assert.equal(parseRetryAfter(String(seconds),now),seconds*1000);checks++;}
console.log(JSON.stringify({passed:true,checks}));
`;
}
