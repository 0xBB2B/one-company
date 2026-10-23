---
name: python-pitfalls
description: Python 安全与鲁棒性常见坑：不可信数据反序列化、可变默认参数、asyncio 中的阻塞调用、shell=True、eval/exec。
---
# Python 常见坑排查清单

## 安全
### 1. 对不可信数据用 pickle 反序列化
- 问题：`pickle.load` 会执行数据里嵌的代码，攻击者给一个文件就能在你的服务器上运行任意命令。
- 怎么认出：`pickle.load(` / `pickle.loads(` / `shelve` / `pandas.read_pickle`，数据来自网络、上传文件或缓存里用户可写的位置。
- 修法：交换数据改用 JSON 等纯数据格式；一定要用 pickle 时，只读自己生成且做过签名校验的数据。
- 出处：https://docs.python.org/3/library/pickle.html

### 2. yaml.load 反序列化不可信数据
- 问题：PyYAML 的 `yaml.load` 配旧版 Loader 时可以构造任意 Python 对象，等同于执行代码。
- 怎么认出：`yaml.load(` 没有传 `Loader=yaml.SafeLoader`，或用了 `yaml.Loader` / `yaml.UnsafeLoader` / `yaml.FullLoader`。
- 修法：一律用 `yaml.safe_load(...)`。
- 出处：https://pyyaml.org/wiki/PyYAMLDocumentation

### 3. subprocess 用 shell=True 拼接命令
- 问题：命令交给 shell 解析，输入里的 `;`、`&&`、`$()` 会被当成命令执行，造成命令注入。
- 怎么认出：`subprocess.run(f"cmd {x}", shell=True)`、`os.system(`、`os.popen(`，字符串中拼进外部输入。
- 修法：传参数列表并保持 `shell=False`：`subprocess.run(["cmd", x], check=True)`；需要引用时用 `shlex.quote`。
- 出处：https://docs.python.org/3/library/subprocess.html#security-considerations

### 4. 对外部输入用 eval / exec
- 问题：`eval` 和 `exec` 会把字符串当代码执行，外部输入进去就是远程代码执行。
- 怎么认出：`eval(`、`exec(`、`compile(` 的参数来自请求、文件或数据库。
- 修法：解析字面量用 `ast.literal_eval`；解析 JSON 用 `json.loads`；需要的表达式用白名单函数表实现。
- 出处：https://docs.python.org/3/library/functions.html#eval

## 鲁棒性
### 5. 可变默认参数
- 问题：默认值只在函数定义时创建一次，列表或字典默认参数会在多次调用间共享，前一次调用的数据泄漏到下一次。
- 怎么认出：`def f(items=[])`、`def f(opts={})`、`def f(seen=set())`。
- 修法：默认值用 `None`，函数里再创建：`if items is None: items = []`。
- 出处：https://docs.python.org/3/tutorial/controlflow.html#default-argument-values

### 6. asyncio 协程里调用阻塞函数
- 问题：协程里的阻塞调用会卡住整个事件循环，所有并发任务一起停顿，延迟飙升甚至超时。
- 怎么认出：`async def` 里出现 `time.sleep`、`requests.get`、同步数据库驱动、大文件同步读写、`subprocess.run`。
- 修法：换成异步版本（`asyncio.sleep`、`httpx.AsyncClient`）；无法替换时用 `await asyncio.to_thread(func, ...)`。
- 出处：https://docs.python.org/3/library/asyncio-dev.html#running-blocking-code

## 文件与路径
### 7. 路径穿越
- 问题：把用户给的文件名拼到目录后面，`../` 可以跳出目录，读写任意文件。
- 怎么认出：`open(os.path.join(base, user_name))`、`send_file(user_path)`，没有检查最终路径是否在 base 之内。
- 修法：`p = (base / name).resolve()` 后检查 `p.is_relative_to(base.resolve())`，不通过就拒绝。
- 出处：https://owasp.org/www-community/attacks/Path_Traversal

### 8. 解压压缩包路径和大小不设防
- 问题：tar 成员可以是 `../x` 或指向外部的链接；zip 的 `extract` / `extractall` 会自动去掉开头的 `/` 和 `..`，但自己拼路径时不会；解压总大小不限时，压缩炸弹会占满磁盘。
- 怎么认出：Python 3.12 / 3.13 下 `tarfile.extractall(` 没传 `filter=`（3.14 起默认是 `data`）；`os.path.join(dest, info.filename)` 自己拼 zip 成员路径；用 `zipfile.Path` 取成员路径；解压前后没检查总大小。
- 修法：tar 用 `extractall(path, filter="data")`；zip 自己拼路径前先 resolve 并检查在目标目录内；累计解压大小，超过上限就中止。
- 出处：https://docs.python.org/3/library/tarfile.html#tarfile-extraction-filter 、https://docs.python.org/3/library/zipfile.html#zipfile.ZipFile.extractall

### 9. 用 tempfile.mktemp 创建临时文件
- 问题：`mktemp` 只返回名字不创建文件，名字被别人抢先创建（符号链接攻击）时，你会写到不该写的地方。
- 怎么认出：`tempfile.mktemp(`、固定路径 `/tmp/xxx`。
- 修法：用 `tempfile.NamedTemporaryFile`、`TemporaryDirectory` 或 `mkstemp`。
- 出处：https://docs.python.org/3/library/tempfile.html#tempfile.mktemp

## 注入与输入
### 10. SQL 用字符串拼接或格式化
- 问题：用户输入拼进 SQL，会造成 SQL 注入。
- 怎么认出：`cursor.execute(f"... {x}")`、`"..." % x`、`.format(`。
- 修法：用占位符并把参数单独传入：`cur.execute("SELECT * FROM t WHERE id = ?", (id,))`。
- 出处：https://docs.python.org/3/library/sqlite3.html#sqlite3-placeholders

### 11. 用 assert 做输入校验
- 问题：`python -O` 运行时 assert 会被整个删除，校验消失，权限检查形同虚设。
- 怎么认出：`assert user.is_admin`、`assert isinstance(x, int)` 用于检查外部输入或权限。
- 修法：用 `if not cond: raise ValueError(...)`；assert 只用来表达内部不变量。
- 出处：https://docs.python.org/3/reference/simple_stmts.html#the-assert-statement

### 12. 处理不可信 XML 时 Expat 版本过低
- 问题：Expat 低于 2.7.2 时，可能受“十亿笑声”、二次膨胀和超大 token 攻击，处理不可信 XML 会耗尽内存或 CPU。
- 怎么认出：对外部 XML 使用 `xml.etree`、`xml.dom.minidom`、`xml.sax`，并且 `pyexpat.EXPAT_VERSION` 低于 2.7.2。
- 修法：升级 Python 或系统的 Expat 到 2.7.2 及以上；限制输入大小；需要更严格的防护时可使用 defusedxml。
- 出处：https://docs.python.org/3/library/xml.html#xml-security 、https://pypi.org/project/defusedxml/

### 13. 日志注入
- 问题：把含换行的用户输入原样写进日志，攻击者可以伪造日志行。
- 怎么认出：`logger.info("login " + username)`，username 未过滤换行。
- 修法：用参数化日志，输出前去掉或转义换行；日志用结构化格式。
- 出处：https://owasp.org/www-community/attacks/Log_Injection

### 14. 模板自动转义被关闭
- 问题：关闭自动转义后，用户输入会原样进入 HTML，造成 XSS。
- 怎么认出：`Environment(...)` 没有传 `autoescape`（Jinja 的 Environment 默认不转义）；`autoescape=False`；模板里大量 `|safe`、`Markup(user_input)`。
- 修法：开启 `autoescape`（`select_autoescape()`），只对确信安全的内容用 `|safe`。
- 出处：https://jinja.palletsprojects.com/en/stable/api/#autoescaping

### 15. Flask 调试模式上线
- 问题：调试模式提供交互式调试器，可在服务器上执行任意代码。
- 怎么认出：`app.run(debug=True)`、`FLASK_DEBUG=1`、`DEBUG = True` 出现在生产配置。
- 修法：生产用 gunicorn 等 WSGI 服务器启动，关闭调试。
- 出处：https://flask.palletsprojects.com/en/stable/debugging/

## 网络与密码学
### 16. requests 不设 timeout
- 问题：`requests` 默认永不超时，对端卡住时线程永久挂起。
- 怎么认出：`requests.get(url)`、`session.post(url, ...)` 没有 `timeout=`。
- 修法：`requests.get(url, timeout=(3.05, 10))`。
- 出处：https://requests.readthedocs.io/en/latest/user/quickstart/#timeouts

### 17. 关闭 TLS 证书校验
- 问题：`verify=False` 让中间人可以冒充服务端，窃取或篡改通信内容。
- 怎么认出：`verify=False`、`ssl._create_unverified_context()`、`CERT_NONE`。
- 修法：保持校验；私有 CA 用 `verify="/path/ca.pem"`。
- 出处：https://requests.readthedocs.io/en/latest/user/advanced/#ssl-cert-verification

### 18. 用 random 模块生成令牌
- 问题：`random` 是可预测的伪随机数，不适合安全用途。
- 怎么认出：令牌、验证码、密码重置码的生成用了 `random.choice`、`random.randint`。
- 修法：用 `secrets.token_urlsafe(32)` 等。
- 出处：https://docs.python.org/3/library/random.html

### 19. 用 MD5 / SHA1 存密码
- 问题：快速哈希可被暴力破解，数据库泄漏后密码很快被还原。
- 怎么认出：直接用 `hashlib.md5`、`hashlib.sha1`、`hashlib.sha256` 等快速哈希存密码，不论加不加盐。
- 修法：用 argon2id、bcrypt 或 scrypt。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html

### 20. 用 == 比较签名或令牌
- 问题：普通比较在第一个不同位置就返回，响应时间泄漏了已匹配的位数，可被计时攻击利用。
- 怎么认出：`sig == expected`、`token == stored`、`hmac_obj.hexdigest() == given`。
- 修法：用 `hmac.compare_digest(a, b)`。
- 出处：https://docs.python.org/3/library/hmac.html#hmac.compare_digest

## 并发与进程
### 21. 循环里的 lambda 晚绑定
- 问题：闭包里的变量在调用时才取值，循环结束后全部取到最后一个值。
- 怎么认出：`[lambda: i for i in range(3)]`、循环里往回调注册引用循环变量的函数。
- 修法：用默认参数固定值 `lambda i=i: i`，或用 `functools.partial`。
- 出处：https://docs.python.org/3/faq/programming.html#why-do-lambdas-defined-in-a-loop-with-different-values-all-return-the-same-result

### 22. 协程忘记 await
- 问题：调用协程函数只得到协程对象，函数体根本没有执行，只在退出时给出一个警告。
- 怎么认出：`async_func()` 作为单独语句，没有 `await` 或 `create_task`。
- 修法：加 `await`；开发时打开 asyncio debug 模式检查。
- 出处：https://docs.python.org/3/library/asyncio-dev.html#detect-never-awaited-coroutines

### 23. create_task 的返回值没人持有
- 问题：事件循环只保留任务的弱引用，没人持有时任务可能在执行中途被垃圾回收。
- 怎么认出：`asyncio.create_task(coro())` 的返回值被丢弃。
- 修法：把任务放进集合保存，完成后用 `add_done_callback` 移除；或用 `TaskGroup`。
- 出处：https://docs.python.org/3/library/asyncio-task.html#asyncio.create_task

### 24. 吞掉 CancelledError
- 问题：捕获 `CancelledError` 后不再抛出，任务取消、超时机制都会失灵，程序无法正常退出。
- 怎么认出：`except BaseException:`、`except asyncio.CancelledError: pass`。
- 修法：清理之后重新 `raise`。
- 出处：https://docs.python.org/3/library/asyncio-task.html#task-cancellation

### 25. subprocess 没有超时
- 问题：子进程卡住时调用方永久等待。
- 怎么认出：`subprocess.run(...)`、`communicate()` 没有 `timeout=`。
- 修法：`subprocess.run(cmd, timeout=30, check=True)`，捕获 `TimeoutExpired`。
- 出处：https://docs.python.org/3/library/subprocess.html#subprocess.run

### 26. SSRF：服务端按用户给的 URL 发请求
- 问题：攻击者让服务请求内网地址或云厂商元数据地址，读到内部信息。
- 怎么认出：`requests.get(user_url)`、`httpx.get(url)` 的 URL 来自请求参数，没有白名单。
- 修法：域名白名单；解析后拒绝内网和回环地址；关闭自动重定向（`allow_redirects=False`）后逐跳检查。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html

### 27. ReDoS：正则回溯耗尽 CPU
- 问题：写得不好的正则遇到特殊输入时匹配时间指数增长，一个请求就能占满一个 CPU 核。
- 怎么认出：嵌套量词 `(a+)+`、`(.*)*`，用 `re.match` 匹配外部输入且没有长度限制。
- 修法：改写成无歧义的正则，先限制输入长度。
- 出处：https://owasp.org/www-community/attacks/Regular_expression_Denial_of_Service_-_ReDoS

### 28. 请求体和上传文件不限大小
- 问题：不限大小时，攻击者上传超大请求会占满内存或磁盘。
- 怎么认出：Flask 配置里没有 `MAX_CONTENT_LENGTH`；`request.get_data()`、`file.read()` 读取整个上传内容。
- 修法：设置 `MAX_CONTENT_LENGTH`（Django 用 `DATA_UPLOAD_MAX_MEMORY_SIZE`）；大文件分块读取。
- 出处：https://flask.palletsprojects.com/en/stable/config/#MAX_CONTENT_LENGTH
