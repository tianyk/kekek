---
title: jq
author: tyk
date: 2019-06-21 19:14:31
tags:
---

## JQ

jq 是个非常强大的处理 JSON 数据的命令行工具。

### 安装

- Linux

	```
	yum install jq
	```

- macOS

	```
	brew install jq
	```

### 使用示例

> 注意：示例数据不是一段json数据，它的每一行都是一条json数据。每一行都会处理一次。

1. 格式化

> 这里的 `.` 表示当前JSON对象

```bash 
curl -s https://blog.kurl.cc/static/jq.json | jq .
```

2. 查询

> 查询 `remote_addr` 为 `187.141.142.230` 的用户

```bash
curl -s https://blog.kurl.cc/static/jq.json | jq 'select (.["remote_addr"] == "187.141.142.230")'
```

`select(boolean_expression)` 为查询语句，`.["remote_addr"]` 表示取对象的`remote_addr`属性（除了可以用`.[]`取值还可以直接`.`取值，前者可以处理特殊字符的情况）。 `==` 表示等于。

> 查询 `method` 为 `GET` 的请求，并且`status` 为 `200`

```bash
curl -s https://blog.kurl.cc/static/jq.json | jq 'select (.["method"] == "GET" and .status == 200)'
```

3. 管道

```ts
interface AccessLog {
	ip: string;
	method: string;
	url: string;
}
```

```bash
curl -s https://blog.kurl.cc/static/jq.json | jq '. | {ip: .["remote_addr"], method: .method, url: .["request_uri"]}'
```

这里使用了管道符 `|` 可以多次处理结果

4. 输出csv格式

> csv 的输入要求必须是一个数组

```bash
curl -s https://blog.kurl.cc/static/jq.json | jq '. | [.["remote_addr"], .method, .status]] | @csv'
```

5. 数组 

`.[]` 表示取整个数组，一般配合管道符号一起使用 `.[] | {ip: .["remote_addr"], method: .method, url: .["request_uri"]}`

`.[0]` 表示取数组的第一个元素


### 参考

- [Tutorial](https://stedolan.github.io/jq/tutorial/)
- [jq Manual](https://stedolan.github.io/jq/manual/)