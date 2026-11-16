#!/usr/bin/env python3
"""Перевірка файла конвеєра й закріплених дій (підрозділи 7.6.2 і 7.6.3, таблиця 7.13).
  1. actionlint на чинному ci.yml — actionlint-good.log (очікується 0 помилок).
  2. actionlint на копії ci.yml із трьома навмисними помилками — actionlint-bad.log (очікується три повідомлення):
     вираз github.event.pull_request.title у run, needs з назвою неіснуючого завдання, контекст secret замість secrets.
  3. Для кожної дії, закріпленої за SHA з тегом у коментарі (ci.yml і .github/actions/*/action.yml), `git ls-remote`
     порівнює SHA з тегом у репозиторії дії — actions-sha-check.txt (крок потребує мережі).
actionlint 1.7.12 береться з PATH, а за його відсутності — з образу rhysd/actionlint:1.7.12 (потрібен Docker).
Файли перевіряються в тимчасовій копії з каталогом .git: так actionlint знаходить корінь проєкту, як у репозиторії.
Результат — results/ (або CALC7_OUT). Запуск: python3 calc7-actionlint.py"""
import datetime, glob, os, re, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.environ.get('CALC7_OUT', os.path.join(HERE, 'results'))
os.makedirs(OUT, exist_ok=True)
VERSION = '1.7.12'
WORKFLOW = os.path.join('.github', 'workflows', 'ci.yml')

# (що замінюємо, на що): кожен рядок має траплятися в ci.yml рівно один раз
BAD = [
    ('      - run: npm run lint\n',
     '      - run: npm run lint\n      - run: echo "${{ github.event.pull_request.title }}"\n'),
    ('    needs: [test, e2e]\n', '    needs: [tets, e2e]\n'),
    ('password: ${{ secrets.GITHUB_TOKEN }}', 'password: ${{ secret.GITHUB_TOKEN }}'),
]


def make_repo(workflow_text=None):
    """Тимчасова копія каталогу .github (із підміненим ci.yml, якщо задано) і порожній git-репозиторій."""
    root = tempfile.mkdtemp(prefix='actionlint.')
    shutil.copytree(os.path.join(HERE, '.github'), os.path.join(root, '.github'))
    if workflow_text is not None:
        open(os.path.join(root, WORKFLOW), 'w', encoding='utf-8').write(workflow_text)
    subprocess.run(['git', 'init', '-q', root], check=True)
    return root


def actionlint(root):
    if shutil.which('actionlint'):
        cmd, cwd = ['actionlint', '-verbose'], root
    elif shutil.which('docker') and subprocess.run(['docker', 'info'], capture_output=True).returncode == 0:
        cmd = ['docker', 'run', '--rm', '-v', f'{root}:/repo', '--workdir', '/repo',
               f'rhysd/actionlint:{VERSION}', '-verbose']
        cwd = None
    else:
        return None, 'немає ні actionlint, ні Docker: крок пропущено\n'
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


def lint(name, workflow_text=None):
    root = make_repo(workflow_text)
    try:
        rc, text = actionlint(root)
    finally:
        shutil.rmtree(root, ignore_errors=True)
    if rc is None:                      # аналізатора немає: файл не пишемо, щоб не видати пропуск за результат
        print(f'{name}: {text.strip()}')
        return rc
    open(os.path.join(OUT, name), 'w', encoding='utf-8').write(text + f'rc={rc}\n')
    print(f'{name}: rc={rc}')
    return rc


def sha_check():
    pins = {}
    files = [os.path.join(HERE, WORKFLOW)] + glob.glob(os.path.join(HERE, '.github', 'actions', '*', 'action.yml'))
    for f in files:
        for repo, sha, tag in re.findall(r'uses:\s*([\w.-]+/[\w.-]+)@([0-9a-f]{40})\s*#\s*(v[\w.]+)',
                                         open(f, encoding='utf-8').read()):
            pins[(repo, tag)] = sha
    today = datetime.date.today().strftime('%d.%m.%Y')
    lines = [f'# git ls-remote: SHA з ci.yml і action.yml проти тегів у репозиторіях дій ({today})']
    bad = 0
    for (repo, tag), sha in sorted(pins.items()):
        r = subprocess.run(['git', 'ls-remote', f'https://github.com/{repo}', f'refs/tags/{tag}', f'refs/tags/{tag}^{{}}'],
                           capture_output=True, text=True)
        refs = {ref: s for s, ref in (row.split('\t') for row in r.stdout.splitlines())}
        # анотований тег показує два рядки: сам тег і коміт, на який він указує (^{})
        real = refs.get(f'refs/tags/{tag}^{{}}') or refs.get(f'refs/tags/{tag}')
        verdict = 'збігається' if real == sha else f'НЕ ЗБІГАЄТЬСЯ: у репозиторії {real}'
        bad += real != sha
        lines.append(f'{repo}@{tag} {sha} {verdict}')
    open(os.path.join(OUT, 'actions-sha-check.txt'), 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
    print('\n'.join(lines))
    return bad


text = open(os.path.join(HERE, WORKFLOW), encoding='utf-8').read()
broken = text
for old, new in BAD:
    assert broken.count(old) == 1, f'у ci.yml змінилися рядки, які псує цей скрипт: {old!r}'
    broken = broken.replace(old, new)
lint('actionlint-good.log')
lint('actionlint-bad.log', broken)
sys.exit(1 if sha_check() else 0)
