---
name: python-coding
description: Python 编码规范：PEP 8、类型标注、异常处理、with 管理资源、logging 用法，写 Python 代码时遵守、审查时逐项对照。
---
# Python 编码规范

## 风格与类型
### 1. 命名和格式遵守 PEP 8
- 问题：风格不统一，读代码的人要适应每个人的写法，diff 里混进格式噪声。
- 怎么认出：函数和变量用驼峰（`getUser`），类名用下划线，常量没大写；一行超长；`import *`；缩进不是 4 个空格。
- 修法：函数、变量用 `snake_case`，类用 `CapWords`，常量用 `UPPER_CASE`；用格式化工具（ruff 或 black）统一。
- 出处：https://peps.python.org/pep-0008/

### 2. 函数签名写类型标注（PEP 484）
- 问题：没有标注，调用方不知道该传什么、会返回什么，类型检查器也帮不上忙。
- 怎么认出：`def f(a, b):` 没有 `->` 和参数类型；公共函数返回 `dict` 却没说里面是什么。
- 修法：参数和返回值都写标注，如 `def load(path: str) -> list[User]:`；用 mypy 或 pyright 检查。
- 出处：https://peps.python.org/pep-0484/

## 异常与资源
### 3. 不写裸 except:，不吞异常
- 问题：裸 `except:` 连 `KeyboardInterrupt`、`SystemExit` 也一起捕获，`except Exception: pass` 让错误悄悄消失，出问题时没有任何线索。
- 怎么认出：`except:`；`except Exception:` 后面是 `pass` 或 `continue`，没有记录也没有重新抛出。
- 修法：只捕获预期的具体异常；确实要处理就记录日志，处理不了就 `raise` 向上抛。
- 出处：https://docs.python.org/3/tutorial/errors.html#handling-exceptions

### 4. 资源用 with 管理
- 问题：手动 `open` / `close` 时，中间抛异常就走不到 `close`，文件、连接、锁一直不释放。
- 怎么认出：`f = open(...)` 后面没有 `with`；`lock.acquire()` 没有 `try/finally` 或 `with lock`。
- 修法：写 `with open(path) as f:`；自己的资源类实现 `__enter__` / `__exit__`，或用 `contextlib.contextmanager`。
- 出处：https://docs.python.org/3/reference/compound_stmts.html#the-with-statement

## 日志
### 5. logging 参数化，不提前拼字符串
- 问题：用 f-string 或 `%` 提前拼好再传入，即使日志级别被关掉也要付出拼接成本；日志系统也没法按模板归并同类消息。
- 怎么认出：`logger.info(f"user {uid}")`、`logger.debug("x=" + str(x))`、用 `print` 代替日志。
- 修法：`logger.info("user %s", uid)`，由 logging 在需要输出时才格式化；记录异常用 `logger.exception(...)`。
- 出处：https://docs.python.org/3/howto/logging.html#logging-variable-data

## 风格细节
### 6. import 写在文件顶部，分组，不用 import *
- 问题：`from x import *` 让读者不知道名字从哪来，还可能覆盖已有名字；import 散在函数中间不易看出依赖。
- 怎么认出：`from module import *`；文件中间出现 import。
- 修法：顶部按标准库、第三方、本项目分三组，每组空行隔开，只导入用到的名字。
- 出处：https://peps.python.org/pep-0008/#imports

### 7. 与 None 比较用 is，布尔值不写 == True
- 问题：`== None` 会触发自定义的 `__eq__`，结果不可靠；`if x == True` 多余，对非布尔值还会出错。
- 怎么认出：`== None`、`!= None`、`== True`、`== False`。
- 修法：写 `x is None`、`x is not None`、`if x:`。
- 出处：https://peps.python.org/pep-0008/#programming-recommendations

### 8. 不把 lambda 赋给变量
- 问题：赋值给变量的 lambda 没有函数名，报错栈里只显示 `<lambda>`，也不能写文档。
- 怎么认出：`f = lambda x: x * 2`。
- 修法：用 `def f(x): return x * 2`；lambda 只在作为参数时临时使用。
- 出处：https://peps.python.org/pep-0008/#programming-recommendations

### 9. 公共模块、类、函数写 docstring
- 问题：没有说明，使用者只能读实现；各人格式不一，工具也生成不了文档。
- 怎么认出：公共函数、类定义下方直接是代码，没有三引号字符串。
- 修法：第一行写一句话概述，需要时空一行再写参数和返回值说明。
- 出处：https://peps.python.org/pep-0257/

### 10. 用 pathlib 处理路径
- 问题：手拼字符串路径（`dir + "/" + name`）在不同系统上出错，也容易忘记处理分隔符。
- 怎么认出：`os.path.join` 嵌套多层、字符串 `+ "/" +`。
- 修法：用 `Path(base) / name`，并用 `.read_text(encoding="utf-8")` 等方法。
- 出处：https://docs.python.org/3/library/pathlib.html

### 11. 打开文本文件显式指定 encoding
- 问题：Python 3.15 以下，不写 encoding 时使用系统默认编码，在不同机器上读同一个文件得到乱码或报错。
- 怎么认出：`open(path)`、`open(path, "w")` 没有 `encoding=`。
- 修法：`open(path, encoding="utf-8")`。3.15 起默认启用 UTF-8 模式，但需要支持旧版本时仍应显式写出。
- 出处：https://peps.python.org/pep-0597/ 、https://peps.python.org/pep-0686/

### 12. 数据载体用 dataclass
- 问题：手写 `__init__`、`__repr__`、`__eq__` 冗长，字段多了容易漏改。
- 怎么认出：只有赋值字段的类，写了一大段样板方法。
- 修法：用 `@dataclass`（需要不可变时 `frozen=True`）。
- 出处：https://docs.python.org/3/library/dataclasses.html

## 类型与异常
### 13. 可空写成 X | None，少用 Any
- 问题：`Any` 让类型检查对这个值失效，可空值不标出来调用方会漏判 None。
- 怎么认出：`def f(x: Any)`；可能返回 None 的函数标注为只返回 `str`。
- 修法：写 `str | None`（Python 3.10 起），并在使用前检查；真不确定类型时用 `object` 再收窄。
- 出处：https://peps.python.org/pep-0604/

### 14. 重新抛出异常时保留原因
- 问题：捕获后抛出新异常却丢掉原异常，排查时看不到真正的原因。
- 怎么认出：`except KeyError: raise ValueError("bad")` 且没有 `from`。
- 修法：`raise ValueError("bad") from e`；只想往上抛时直接 `raise`。
- 出处：https://docs.python.org/3/tutorial/errors.html#exception-chaining

### 15. 自定义异常继承 Exception
- 问题：继承 `BaseException` 会被 `except Exception` 漏掉，还可能拦截退出信号；直接抛 `Exception("...")` 调用方无法区分类型。
- 怎么认出：`class MyError(BaseException)`；大量 `raise Exception("...")`。
- 修法：为每类业务错误定义继承自 `Exception` 的子类，按需要组织层次。
- 出处：https://docs.python.org/3/tutorial/errors.html#user-defined-exceptions

### 16. try 块只包最小范围
- 问题：try 里放太多语句，不相关代码的异常也被当成预期异常处理掉，掩盖真正的 bug。
- 怎么认出：`try:` 下面几十行；`except ValueError` 下面的处理与其中大部分代码无关。
- 修法：try 只包会抛出该异常的那一两行，其余放进 `else:` 或外面。
- 出处：https://peps.python.org/pep-0008/#programming-recommendations

### 17. 用 contextlib 写简单的上下文管理器
- 问题：为了用 `with` 而手写完整的 `__enter__` / `__exit__` 类，代码冗长且容易漏掉异常路径的清理。
- 怎么认出：只做“获取 → 使用 → 释放”的小类，里面有 `__enter__`、`__exit__`。
- 修法：用 `@contextmanager` 生成器，`try/finally` 里释放；或用 `contextlib.closing`、`suppress`。
- 出处：https://docs.python.org/3/library/contextlib.html

## 函数与模块
### 18. 日期时间使用带时区的对象
- 问题：不带时区的 datetime 在不同机器、夏令时下含义不同，比较和存储容易出错。
- 怎么认出：`datetime.now()`、`datetime.utcnow()`、`datetime.utcfromtimestamp()`。
- 修法：`datetime.now(timezone.utc)`；存储用 UTC，展示时才转本地时区。
- 出处：https://docs.python.org/3/library/datetime.html#aware-and-naive-objects

### 19. 金额等精确数值用 Decimal
- 问题：浮点数无法精确表示 0.1，金额累加后会差几分钱。
- 怎么认出：价格、余额用 `float` 做加减乘除，并与 `==` 比较。
- 修法：用 `decimal.Decimal("0.10")`（从字符串构造）；或以整数分计。
- 出处：https://docs.python.org/3/library/decimal.html

### 20. 遍历时不修改正在遍历的集合
- 问题：边遍历列表边删元素会跳过元素；遍历字典时增删键会抛 RuntimeError。
- 怎么认出：`for x in items: items.remove(x)`；`for k in d: del d[k]`。
- 修法：遍历副本 `for x in list(items)`，或用推导式生成新集合。
- 出处：https://docs.python.org/3/tutorial/controlflow.html#for-statements

### 21. 脚本入口放在 __main__ 判断里
- 问题：模块被导入时就执行了脚本逻辑，测试和复用都会出现副作用。
- 怎么认出：文件末尾直接调用 `main()` 或写业务语句，没有条件判断。
- 修法：`if __name__ == "__main__": main()`。
- 出处：https://docs.python.org/3/library/__main__.html

### 22. 每个模块用 logging.getLogger(__name__)
- 问题：使用根 logger 或各处自己配置，无法按模块调整级别，也容易重复输出。
- 怎么认出：直接调用 `logging.info(...)`；库代码里调用 `basicConfig`。
- 修法：模块顶部 `logger = logging.getLogger(__name__)`，只在程序入口配置 handler。
- 出处：https://docs.python.org/3/howto/logging.html#advanced-logging-tutorial

### 23. 拼接大量字符串用 join
- 问题：在循环里反复用 `+=` 拼接字符串，可能产生大量中间对象，慢且占内存。
- 怎么认出：`for` 循环里 `s += piece`。
- 修法：先放进列表，再 `"".join(parts)`。
- 出处：https://peps.python.org/pep-0008/#programming-recommendations
