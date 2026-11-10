# 给短剧容器配置 OpenAI 出站代理

## 当前状态

已准备并验证配置，**尚未上传节点凭据或启用服务器代理**。Mihomo配置通过无网络语法检查，Compose合并检查通过；真实云端连通性尚未验证。代理只能处理网络路径，使用仍需符合OpenAI服务地区和账号要求。

## 这次采用的方式

Mac使用ClashX，云服务器使用支持相同节点协议的Mihomo。无需把Mac设成公共代理服务器。已从本机ClashX缓存配置中准备一个带日本标签的Shadowsocks节点快照，未复制整个订阅链接，也不读取或复制OpenAI Key。

请求路径：短剧容器 → Docker内部Mihomo代理 → 原有订阅节点 → OpenAI。其他目标在Mihomo规则中直接连接。

代理容器不发布宿主机端口，不使用TUN、特权模式或NET_ADMIN，不修改云服务器的全局路由。网站入口的Caddy负责浏览器到网站的HTTPS，与这里的出站代理分开管理。

## 文件与用途

| 文件 | 作用 |
| --- | --- |
| `/opt/drama-plus/compose.yaml` | 原有短剧运行配置 |
| `/opt/drama-plus/compose.proxy.yaml` | 可选代理容器和短剧代理环境变量 |
| `/opt/drama-plus/proxy/config.yaml` | 一个节点的连接凭据与OpenAI分流规则；应限制访问权限 |
| `/opt/drama-plus/data` | 原有数据库和媒体；启用代理继续复用 |

仓库中的`deploy/tencent-private/compose.proxy.yaml`不含节点密码。`deploy/tencent-private/proxy/`已加入Git忽略规则，源码打包脚本仅包含代理Compose，不包含节点配置。私密上传包与源码包分开，上传前需要确认传输其中的节点凭据。

## 为什么需要重建容器

当前应用镜像使用Node.js 22.23.4，支持`NODE_USE_ENV_PROXY=1`。Compose将HTTP_PROXY和HTTPS_PROXY指向Docker内部地址`http://egress:7890`。只在服务器终端执行export不会改变已经启动的应用容器，需要用Compose重建应用才能载入这些变量。

## 服务器启用步骤（准备完成，尚未执行）

在没有生成或合成任务时操作，容器重建会短暂中断网站请求。私密包上传到`/home/ubuntu`后，先核对上传前后的SHA256，再解压到新的临时目录。不要把节点密码粘贴到终端命令里或发到聊天中，也不要直接展示配置文件内容。

1. 用`docker load`导入已核对来源的Mihomo镜像，避免服务器直连镜像仓库失败。
2. 将代理Compose放到`/opt/drama-plus/compose.proxy.yaml`，将私密配置安装到`/opt/drama-plus/proxy/config.yaml`。目录权限700、配置文件权限600。
3. 使用Mihomo的`-t`选项检查配置，再校验合并后的Compose。
4. 启动代理及应用：

```bash
cd /opt/drama-plus
sudo docker compose -f compose.yaml -f compose.proxy.yaml config --quiet
sudo docker compose -f compose.yaml -f compose.proxy.yaml up -d
```

**作用：** 第二个`-f`把可选代理配置叠加到原应用配置。仍使用原镜像、原数据目录和127.0.0.1:5679绑定，不向公网新增7890或9090端口。

## 如何判断成功

先在实际应用容器中不带Key请求`https://api.openai.com/v1/models`。得到HTTP 401只证明建立连接并收到了HTTP响应，不代表Key有效。然后由本人在网站里点击“测试配置”，返回200才说明该Key的模型列表请求通过。整个过程无需提交计费生成任务。

最后检查短剧健康接口、公网HTTPS和密码保护仍正常。代理连通不代表所有模型均可用，真实生成与额度需要另行验证。

## 更新与回退

以后更新应用后，需要再次使用带两个`-f`的启动命令；只用原基础配置启动会移除应用的代理环境变量。本次准备的是单个节点快照，订阅到期、节点地址或密码变化时，需要重新导出并安装，不能认为会自动更新订阅。

如需撤回代理设置，在没有生成任务时执行：

```bash
cd /opt/drama-plus
sudo docker compose -f compose.yaml up -d app
sudo docker compose -f compose.yaml -f compose.proxy.yaml stop egress
```

先使应用恢复直连，再停止代理。不会删除data目录；OpenAI直连仍可能超时，其他服务按原来的网络环境运行。

## 参考

- [Mihomo官方发布 v1.19.33](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.33)
- [Mihomo全局配置](https://wiki.metacubex.one/en/config/general/)
- [Node.js环境代理支持](https://nodejs.org/en/blog/release/v22.21.0)
- [OpenAI API支持地区](https://developers.openai.com/api/docs/supported-countries)
