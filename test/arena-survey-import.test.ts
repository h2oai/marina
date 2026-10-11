// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("survey workbook importer follows relationship identity and rejects incomplete or revised schemas", () => {
  const script = `
import importlib.util, pathlib, tempfile, zipfile, sys
spec = importlib.util.spec_from_file_location("survey", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
def sheet(value):
    rows = [('Do you approve?', '2026-10-01'), ('Approve', value), ('Disapprove', .5), ('Not sure', .1), ('Base', 1000), ('Unweighted base', 900)]
    return '<worksheet xmlns="'+ns+'"><sheetData>' + ''.join('<row r="'+str(i)+'"><c r="A'+str(i)+'" t="inlineStr"><is><t>'+label+'</t></is></c><c r="B'+str(i)+'" t="inlineStr"><is><t>'+str(v)+'</t></is></c></row>' for i,(label,v) in enumerate(rows,1)) + '</sheetData></worksheet>'
def archive(path, edits={}):
    parts = {
        'xl/workbook.xml': '<workbook xmlns="'+ns+'" xmlns:r="'+rel+'"><sheets><sheet name="Democrat" r:id="r2"/><sheet name="US Registered Voters" r:id="r1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/one.xml" Type="'+rel+'/worksheet"/><Relationship Id="r2" Target="worksheets/two.xml" Type="'+rel+'/worksheet"/></Relationships>',
        'xl/worksheets/one.xml': sheet(.4), 'xl/worksheets/two.xml': sheet(.7)}
    parts.update(edits)
    with zipfile.ZipFile(path,'w') as z:
        for name,content in parts.items(): z.writestr(name,content)
with tempfile.TemporaryDirectory() as tmp:
    path = pathlib.Path(tmp)/'survey.xlsx'
    archive(path)
    args = (path, 'https://archive.example/workbook.xlsx', '2026-10-02', 'presidential job approval')
    wave = module.parse(*args)[0]
    all_approve = next(c for c in wave['cells'] if c['subgroup']=='all' and c['response']=='total approval')
    dem_approve = next(c for c in wave['cells'] if c['subgroup']=='Democrat' and c['response']=='total approval')
    assert all_approve['value']==40 and dem_approve['value']==70
    assert all_approve['weightedBase']==1000 and all_approve['unweightedBase']==900
    assert len(wave['documentHash'])==64 and wave['availableAt']=='2026-10-02'
    for malformed in [sheet(40), sheet(.4).replace('Not sure','Maybe'), sheet(.4).replace('2026-10-01','2026-02-30'), sheet(.4).replace('900','inf')]:
        archive(path, {'xl/worksheets/one.xml': malformed})
        try: module.parse(*args)
        except (ValueError, KeyError): pass
        else: raise AssertionError('malformed workbook accepted')
`;
  const result = Bun.spawnSync([
    "python3",
    "-B",
    "-c",
    script,
    resolve(import.meta.dir, "../scripts/arena-survey-import.py"),
  ]);
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
