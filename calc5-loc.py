"""M8: рядки коду Dart-клієнта за шарами (без порожніх рядків і коментарів).
   python3 calc5-loc.py [out.json]"""
import glob, json, sys

def code_lines(path):
    n, block = 0, False
    for line in open(path, encoding='utf8'):
        s = line.strip()
        if not s:
            continue
        if block:
            block = '*/' not in s
            continue
        if s.startswith('/*'):
            block = '*/' not in s
            continue
        if s.startswith('//') or s.startswith('*'):
            continue
        n += 1
    return n

layers = {
    'lib/core': glob.glob('mobile/lib/core/*.dart'),
    'lib/platform': glob.glob('mobile/lib/platform/*.dart'),
    'lib/ui': glob.glob('mobile/lib/ui/*.dart'),
    'lib/main.dart': ['mobile/lib/main.dart'],
    'test': glob.glob('mobile/test/*.dart'),
    'test/integration': glob.glob('mobile/test/integration/*.dart'),
}
res = {k: {'files': len(v), 'lines': sum(code_lines(f) for f in v)} for k, v in layers.items()}
lib = sum(res[k]['lines'] for k in ('lib/core', 'lib/platform', 'lib/ui', 'lib/main.dart'))
res['lib_total'] = lib
res['share_pct'] = {k: round(100 * res[k]['lines'] / lib, 1)
                    for k in ('lib/core', 'lib/platform', 'lib/ui', 'lib/main.dart')}
json.dump(res, open(sys.argv[1] if len(sys.argv) > 1 else 'results/m8.json', 'w'), ensure_ascii=False, indent=1)
print(json.dumps(res, ensure_ascii=False))
