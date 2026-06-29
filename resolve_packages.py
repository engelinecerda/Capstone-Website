import re, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

with open('packages.html', encoding='utf-8') as f:
    c = f.read()

pattern = re.compile(r'<<<<<<< HEAD\n(.*?)=======\n(.*?)>>>>>>> [^\n]+\n', re.DOTALL)
for i, m in enumerate(pattern.finditer(c)):
    print(f'--- Conflict {i+1} ---')
    print('HEAD:', m.group(1)[:120])
    print('CODEV:', m.group(2)[:120])
    print()
