---
title: Golang的并发安全
author: tyk
date: 2021-08-27 10:45:57
tags: 
    - queue 
    - golang
    - 并发
---

## Golang的并发安全

在有多个`goroutines`同时访问并且至少有一个`goroutines`在修改数据的情况下就会存在并发问题。Golang处理并发安全有锁和`channel`两种方案，前者通过加锁方式保证同一时刻只有一个操作在访问数据，后者是将操作串行化来来实现同一时刻只能有一个操作访问数据。这两种方法都是在通过约束并发访问/修改数据来解决并发安全问题。

在`Golang`官网有一段关于并发安全的建议：

> [Advice](https://golang.org/ref/mem#tmp_1)
> 
> Programs that modify data being simultaneously accessed by multiple goroutines must serialize such access.
> To serialize access, protect the data with channel operations or other synchronization primitives such as those in the sync and sync/atomic packages.
> If you must read the rest of this document to understand the behavior of your program, you are being too clever.
> Don't be clever.

下面我将从实现一个并发安全的队列来介绍`Golang`里面的并发工具。

### 并发安全的队列

一个简单的队列最少有`Add`和`Pop`两个操作，队列内部一般通过列表或者链表来存放数据。这两个操作都是对底层的列表或者链表的写操作。底层的列表和链表并不是并发安全的，在多个`goroutines`在同时`Add`或`Pop`时就会有并发问题。

要实现一个并发安全的队列，就要在`Add`和`Pop`操作加锁：

```golang
type Queue struct {
    elements []interface{}
    lock *sync.Mutex
}

func (q *Queue) Pop() (ele interface{}) {
    q.lock.Lock()
    defer q.lock.Unlock()

    ele = q.elements[q.Size()-1]
    q.elements = q.elements[:q.Size()-1]
    return
}

func (q *Queue) Add(ele interface{}) {
    q.lock.Lock()
    defer q.lock.Unlock()

    q.elements = append(q.elements, ele)
}
```

考虑到现实的情况，我们队列的容量不能是没有限制的，这会有内存方面的问题，我们要限制队列的容量。队列空的时候`Pop`时我们要阻塞直到有值，队列满时我们`Add`要阻塞到队列不满，这种情况就需要`sync.Cond`来阻塞。它和Java中的`内置条件队列`类似，可以使当前`goroutine`在某个状态上一直等待，直到这个状态被激活。

|   Java    |  Golang   |
| --------- | --------- |
|   wait    |   Wait    |
|  notify   |  Signal   |
| notifyAll | Broadcast |

我们需要两个`sync.Cond`条件来分别表示队列为空和队列满两种状态，这两个`sync.Cond`内部要使用同一把锁用在操作`Add`和`Pop`来避免并发问题。

```golang

type Queue struct {
    elements []interface{}
    capacity int

    // 队列未空条件队列
    notEmptyCond *sync.Cond
    // 队列未满条件队列
    notFullCond *sync.Cond
}

func (q *Queue) Size() int {
    return len(q.elements)
}

func (q *Queue) isFull() bool {
    return q.Size() >= q.capacity
}

func (q *Queue) isEmpty() bool {
    return q.Size() == 0
}

func (q *Queue) Pop() (ele interface{}) {
    q.notEmptyCond.L.Lock()
    defer q.notEmptyCond.L.Unlock()

    for q.isEmpty() {
        // 如果队列是空的，就在 `notEmptyCond` 条件上等待 
        // Wait 内部会先释放锁，等到收到满足信号时将重新尝试获得锁
        q.notEmptyCond.Wait()
    }

    ele = q.elements[q.Size()-1]
    q.elements = q.elements[:q.Size()-1]
    // 此时队列中已经 Pop 一个值，不再满。发送`notFullCond`信号激活再此条件 `Wait` 的操作
    q.notFullCond.Signal()
    return
}

// Add
func (q *Queue) Add(ele interface{}) (err error) {
    q.notEmptyCond.L.Lock()
    defer q.notEmptyCond.L.Unlock()

    for q.isFull() {
       q.notFullCond.Wait()
    }

    q.elements = append(q.elements, ele)
    // 此时队列中已经有值，发送队列不为空的信号激活再此条件 `Wait` 的操作
    q.notEmptyCond.Signal()
    return
}

func NewQueue(capacity int) *Queue {
    // 使用同一把锁
    var lock sync.Mutex
    notEmptyCond := sync.NewCond(&lock)
    notFullCond := sync.NewCond(&lock)

    return &Queue{
        elements: make([]interface{}, 0, capacity),
        capacity: capacity,

        notEmptyCond: notEmptyCond,
        notFullCond:  notFullCond,
    }
}
```

`Cond.Wait()`在没有收到条件满足信号时会一直阻塞，有时会出现父`goroutine`异常退出时子`goroutine`还在等待的情况。比如下面的例子：

```go
func TestQueue_Add(t *testing.T) {
    queue := NewQueue(10)
     // 系统当前`goroutine`数量
    expectedNumGoroutine := runtime.NumGoroutine()

    // 新起一个协程 `Pop`，由于队列此时为空。`Pop` 操作永远不会返回
    // chanel要有缓冲区，如果父`goroutine`提前退出，chanel无接收者时。done <- ele 会阻塞，此`goroutine`将不能退出，造成 goroutine leak。
    done := make(chan interface{}, 1)
    go func() {
        // 如果父`goroutine`此时已经退出，这时`Pop`出来的消息将丢失
        ele, _ := queue.Pop()
        done <- ele
    }()

    select {
    case <-time.After(100 * time.Millisecond):
        // parent goroutine exit
        // 由于Pop操作此时还没返回，实际协程数量+1
        assert.Equal(t, expectedNumGoroutine+1, runtime.NumGoroutine())
    case <-done:
        assert.Equal(t, expectedNumGoroutine, runtime.NumGoroutine())
    }
    queue.Add(1)
    time.Sleep(time.Millisecond)

    // 这条消息可能会在父`goroutine`退出后才返回
    assert.Equal(t, 1, <-done)
    assert.Equal(t, 0, queue.Size())
}
```

要解决上面问题，我们就需要使用来`Context`来取消子`goroutine`。下面是完整的例子：

```go
import (
    "context"
    "sync"

    "github.com/pkg/errors"
)

// waitWithCancel 可取消的 Wait
func waitWithCancel(ctx context.Context, cond *sync.Cond) error {
    if ctx.Done() != nil {
        done := make(chan struct{})
        go func() {
            cond.Wait()
            close(done)
        }()

        select {
        case <-ctx.Done():
            return errors.Wrap(ctx.Err(), "cancel wait")
        case <-done:
            return nil
        }
    } else {
        cond.Wait()
        return nil
    }
}

type Queue struct {
    elements []interface{}
    capacity int

    // 队列未空条件队列
    notEmptyCond *sync.Cond
    // 队列未满条件队列
    notFullCond *sync.Cond
}

func (q *Queue) Size() int {
    return len(q.elements)
}

func (q *Queue) isFull() bool {
    return q.Size() >= q.capacity
}

func (q *Queue) isEmpty() bool {
    return q.Size() == 0
}

// Pop
// 可以使用 `Context` 来终止 Wait 阻塞
func (q *Queue) Pop(ctx context.Context) (ele interface{}, err error) {
    q.notEmptyCond.L.Lock()
    defer func() {
        // Wait 内部已经释放了锁，避免 `unlock of unlocked mutex` 错误
        if originalErr := errors.Cause(err);
            originalErr != context.DeadlineExceeded && originalErr != context.Canceled {
            q.notEmptyCond.L.Unlock()
        }
    }()

    for q.isEmpty() {
        err = waitWithCancel(ctx, q.notEmptyCond)
        if err != nil {
            return
        }
    }

    ele = q.elements[q.Size()-1]
    q.elements = q.elements[:q.Size()-1]
    // 此时队列中已经 Pop 一个值，不再满。发送队列不为满的信号激活再此条件 `Wait` 的操作
    q.notFullCond.Signal()
    return
}

// Add
// 可以使用 `Context` 来终止 Wait 阻塞
func (q *Queue) Add(ctx context.Context, ele interface{}) (err error) {
    q.notEmptyCond.L.Lock()
    defer func() {
       // Wait 内部已经释放了锁，避免 `unlock of unlocked mutex` 错误
       if originalErr := errors.Cause(err);
           originalErr != context.DeadlineExceeded && originalErr != context.Canceled {
           q.notEmptyCond.L.Unlock()
       }
    }()

    for q.isFull() {
       err = waitWithCancel(ctx, q.notFullCond)
       if err != nil {
           return
       }
    }

    q.elements = append(q.elements, ele)
    // 此时队列中已经有值，发送队列不为空的信号激活再此条件 `Wait` 的操作
    q.notEmptyCond.Signal()
    return
}

func NewQueue(capacity int) *Queue {
    var lock sync.Mutex
    notEmptyCond := sync.NewCond(&lock)
    notFullCond := sync.NewCond(&lock)

    return &Queue{
        elements: make([]interface{}, 0, capacity),
        capacity: capacity,

        notEmptyCond: notEmptyCond,
        notFullCond:  notFullCond,
    }
}
```

```go
func TestQueue_Add(t *testing.T) {
    queue := NewQueue(10)

    // 100毫秒秒后超时取消
    ctx, cancel := context.WithTimeout(context.Background(), 100 * time.Millisecond)
    defer cancel()
    go func() {
        _, err := queue.Pop(ctx)
        // 超时取消
        assert.Equal(t, context.DeadlineExceeded, errors.Cause(err))
    }()

    // 延迟直到`Pop`超时取消
    time.Sleep(200 * time.Millisecond)
    queue.Add(context.Background(), 1)

    assert.Equal(t, 1, queue.Size())
}
```

### 参考

- [Java并发编程 内置条件队列](https://blog.kurl.cc/post/java.util.concurrent.html#%E5%86%85%E7%BD%AE%E6%9D%A1%E4%BB%B6%E9%98%9F%E5%88%97)
- [Go 语言设计与实现 6.1 上下文 Context](https://draveness.me/golang/docs/part3-runtime/ch06-concurrency/golang-context/)
- [Go 语言设计与实现 6.2 同步原语与锁](https://draveness.me/golang/docs/part3-runtime/ch06-concurrency/golang-sync-primitives/)
- [Implementing Timeout in Golang](https://medium.com/codex/implmenting-timeout-in-golang-ee2bc4aa6ae4)