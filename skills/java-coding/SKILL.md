---
name: java-coding
description: Java 编码规范：命名格式、异常处理、equals 与 hashCode、try-with-resources、Optional 用法，写 Java 代码时遵守、审查时逐项对照。
---
# Java 编码规范

## 风格
### 1. 命名和格式按 Google Java Style（或阿里巴巴 Java 开发手册）
- 问题：团队命名和排版不一致，评审时纠缠格式，真正的问题反而被淹没。
- 怎么认出：类名不是 UpperCamelCase，方法和变量不是 lowerCamelCase，常量没写成 UPPER_SNAKE_CASE；缩进、花括号风格与项目不一致。
- 修法：项目选定一套规范（Google Java Style 或阿里巴巴 Java 开发手册），用 google-java-format、Checkstyle 或手册配套插件自动检查。
- 出处：https://google.github.io/styleguide/javaguide.html

## 异常
### 2. 不吞异常
- 问题：catch 后什么都不做，错误消失，程序带着坏状态继续跑，出问题时没有任何日志可查。
- 怎么认出：空的 `catch` 块；只有 `e.printStackTrace()`；catch 后既不记录也不重新抛出。
- 修法：记录日志并向上抛，或转成有意义的业务异常（带上原异常作为 cause）；确实要忽略时写明原因。
- 出处：https://google.github.io/styleguide/javaguide.html#s6.2-caught-exceptions

### 3. 不 catch Throwable
- 问题：`Throwable` 包含 `OutOfMemoryError` 等 Error，这类问题程序无法恢复，吞掉后进程处于不可预测的状态。
- 怎么认出：`catch (Throwable t)`；`catch (Error e)`。
- 修法：只捕获能处理的具体异常，最宽到 `Exception`；Error 交给上层或让进程退出。
- 出处：https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Error.html

## 对象与资源
### 4. equals 和 hashCode 一起重写
- 问题：只改其一，相等的对象 hashCode 不同，放进 `HashMap` / `HashSet` 后查不到、去不了重。
- 怎么认出：类里有 `equals(Object)` 但没有 `hashCode()`，反之亦然；两个方法用到的字段不一致。
- 修法：两个方法用同一组字段，`hashCode` 用 `Objects.hash(...)`；简单数据类用 `record`。
- 出处：https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Object.html#hashCode()

### 5. 资源用 try-with-resources
- 问题：手写 `finally` 里 close，容易漏掉，close 自己抛异常时还会盖掉原始异常。
- 怎么认出：`new FileInputStream(...)`、`getConnection()`、`new Scanner(...)` 后面没有 try-with-resources；`finally` 里手工 `close()`。
- 修法：`try (var in = Files.newInputStream(p)) { ... }`，资源实现 `AutoCloseable` 即可。
- 出处：https://docs.oracle.com/javase/tutorial/essential/exceptions/tryResourceClose.html

### 6. Optional 只做返回值
- 问题：把 `Optional` 用作字段、方法参数或集合元素，增加调用负担，本身也可能是 null，反而更乱。
- 怎么认出：字段类型或参数类型是 `Optional<...>`；`optional.get()` 前没有判断；`Optional` 包住集合。
- 修法：只用作“可能没有结果”的返回类型；取值用 `orElse`、`orElseThrow`、`map`；集合返回空集合而不是 Optional。
- 出处：https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Optional.html

## 格式与命名细节
### 7. 不用通配符 import
- 问题：`import java.util.*;` 让读者不知道类来自哪里，两个包有同名类时还会冲突。
- 怎么认出：`import xxx.*;`（静态 import 也一样）。
- 修法：逐个导入，让 IDE 自动整理。
- 出处：https://google.github.io/styleguide/javaguide.html#s3.3.1-wildcard-imports

### 8. if / for / while 总是加大括号
- 问题：省略大括号后，后来加一行代码容易被误认为在条件里（goto fail 类 bug）。
- 怎么认出：`if (x) return;` 没有 `{}`，或条件体换行但没括号。
- 修法：始终写 `{ }`，哪怕只有一行。
- 出处：https://google.github.io/styleguide/javaguide.html#s4.1.1-braces-always-used

### 9. 一行只声明一个变量
- 问题：`int a, b = 1;` 容易看错哪个变量被初始化。
- 怎么认出：一条声明里有逗号分隔的多个变量。
- 修法：每个变量单独一行声明。
- 出处：https://google.github.io/styleguide/javaguide.html#s4.8.2.1-variables-per-declaration

### 10. switch 写 default，且不漏 break
- 问题：没有 default 时新增枚举值没被处理却不报错；漏 break 会执行下一个分支。
- 怎么认出：`switch` 缺少 `default`；case 之间没有 `break` 或注释说明有意穿透。
- 修法：补上 `default`（可以抛异常）；Java 14 起用 `->` 形式避免穿透。
- 出处：https://google.github.io/styleguide/javaguide.html#s4.8.4.3-switch-default

### 11. 重写方法始终加 @Override
- 问题：父类方法签名一改，子类原先的“重写”变成新方法，编译器不报错，行为悄悄变了。
- 怎么认出：子类方法与父类同名同参，但没有 `@Override`。
- 修法：所有重写和实现接口的方法都加 `@Override`。
- 出处：https://google.github.io/styleguide/javaguide.html#s6.1-override-annotation

### 12. 静态成员用类名访问
- 问题：通过实例访问静态成员会让人误以为它和实例有关。
- 怎么认出：`obj.staticMethod()`、`this.STATIC_FIELD`。
- 修法：写 `ClassName.staticMethod()`。
- 出处：https://google.github.io/styleguide/javaguide.html#s6.3-static-members

### 13. 常量命名 UPPER_SNAKE_CASE
- 问题：常量与普通变量命名一样，读者分不清能否修改。
- 怎么认出：`static final int maxRetry = 3;`。
- 修法：`static final int MAX_RETRY = 3;`，且只有真正不可变的值才这样命名。
- 出处：https://google.github.io/styleguide/javaguide.html#s5.2.4-constant-names

### 14. 公共类和方法写 Javadoc
- 问题：公共 API 没有说明，使用者只能读实现，参数含义、可空性、抛出的异常都不明确。
- 怎么认出：`public` 类和方法上没有 `/** ... */`。
- 修法：写首句概述；必要时写 `@param`、`@return`、`@throws`。
- 出处：https://google.github.io/styleguide/javaguide.html#s7-javadoc

### 15. 不使用 finalizer
- 问题：finalizer 执行时间不确定，可能永远不执行，还会拖慢垃圾回收。
- 怎么认出：`protected void finalize()`。
- 修法：资源用 try-with-resources 释放；需要在忘记关闭时补救，用 `Cleaner`。
- 出处：https://google.github.io/styleguide/javaguide.html#s6.4-finalizers

## 编码习惯
### 16. 方法入口校验参数用 Objects.requireNonNull
- 问题：null 被存起来，很久之后才在别处抛 NPE，找不到原因。
- 怎么认出：构造函数把参数直接赋给字段，而该参数不允许为空。
- 修法：`this.name = Objects.requireNonNull(name, "name");`。
- 出处：https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Objects.html#requireNonNull(T)

### 17. 返回集合时返回空集合，不返回 null
- 问题：返回 null 要求每个调用方先判空，漏判就 NPE。
- 怎么认出：`return null;` 的方法返回类型是 `List`、`Map`、数组。
- 修法：返回 `List.of()` 或 `Collections.emptyList()`。
- 出处：https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Collections.html#emptyList()

### 18. 字符串比较用 equals，不用 ==
- 问题：`==` 比较的是对象引用，内容相同的两个字符串可能不是同一个对象，结果时真时假。
- 怎么认出：`s == "abc"`、`name != other`，两边是 String。
- 修法：`"abc".equals(s)`（把常量放前面避免 NPE）或 `Objects.equals(a, b)`。
- 出处：https://docs.oracle.com/javase/specs/jls/se21/html/jls-15.html#jls-15.21.3

### 19. 能不可变就不可变
- 问题：可变对象被多处持有，任何一处修改都会影响其他地方，多线程下更危险。
- 怎么认出：字段没有 `final`；getter 直接返回内部的 `List`、`Date`。
- 修法：字段写 `final`；集合用 `List.of`、`List.copyOf`；数据类用 `record`。
- 出处：https://docs.oracle.com/javase/tutorial/essential/concurrency/immutable.html

### 20. 数据载体类用 record
- 问题：手写 getter、equals、hashCode、toString 又长又容易遗漏字段。
- 怎么认出：只有字段加样板方法的类。
- 修法：Java 16 起用 `record Point(int x, int y) {}`。
- 出处：https://openjdk.org/jeps/395

### 21. 局部变量 var 只在类型一目了然时用
- 问题：右边看不出类型时用 var，读者要靠 IDE 才能知道变量类型。
- 怎么认出：`var result = service.process(x);`。
- 修法：右边是 `new Foo()` 这类明显类型时用 var，其余写完整类型。
- 出处：https://openjdk.org/projects/amber/guides/lvti-style-guide

### 22. 不使用原始类型（raw type）
- 问题：`List list = new ArrayList();` 丢掉泛型检查，错误类型的元素到运行时才会出现 ClassCastException。
- 怎么认出：`List`、`Map` 后面没有尖括号。
- 修法：写 `List<String>`，推断时用 `new ArrayList<>()`。
- 出处：https://docs.oracle.com/javase/tutorial/java/generics/rawTypes.html

### 23. 日期时间用 java.time
- 问题：`Date`、`Calendar` 可变、设计混乱，月份从 0 开始等陷阱多。
- 怎么认出：`new Date()`、`Calendar.getInstance()`。
- 修法：用 `Instant`、`LocalDate`、`ZonedDateTime`、`Duration`。
- 出处：https://docs.oracle.com/javase/tutorial/datetime/

### 24. 日志用占位符，不拼字符串
- 问题：先拼接再传入，即使该级别日志被关闭也会付出拼接成本。
- 怎么认出：`log.debug("id=" + id)`。
- 修法：`log.debug("id={}", id)`。
- 出处：https://www.slf4j.org/faq.html#logging_performance

### 25. 受检异常和非受检异常分清用途
- 问题：到处声明 `throws Exception` 把处理责任推给调用方；业务错误全用 RuntimeException 又让调用方不知道要处理什么。
- 怎么认出：方法签名里 `throws Exception`；所有错误都是同一个异常类型。
- 修法：调用方能恢复的错误用受检异常，编程错误和无法恢复的用非受检；异常带上原因。
- 出处：https://docs.oracle.com/javase/tutorial/essential/exceptions/runtime.html
