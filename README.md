# 块运动预测实验台 (BMPP-1)

以**前一重建帧**为参考，对当前帧做 8×8 块运动搜索，生成预测与残差，并把运动矢量
和残差编码成**真实可解码**的实验码流 BMPP-1。附带逐帧/逐块的图形实验界面、独立
解码器和自动化测试。

> BMPP-1 不是任何编码标准（MPEG / H.264 / HEVC / AV1 / VP9 …）的子集，也不声称
> 兼容它们。详见 [docs/FORMAT.md](docs/FORMAT.md)。

## 快速开始

```bash
# 图形界面（主入口）
npm start
# 打开 http://localhost:4173/src/ui/index.html

# 测试（33 项，覆盖格式、往返、搜索策略、三类场景、负例、独立解析器交叉验证）
npm test
```

不需要 `npm install`：没有运行时依赖，Node 只用内置模块，浏览器直接加载 ES 模块。

## 图形入口（主要交付物）

`src/ui/index.html` 是块预测实验界面。启动方式：

```bash
npm start            # 等价于 node scripts/serve.mjs
```

然后访问 `http://localhost:4173/src/ui/index.html`。也可以把仓库根目录用任意静态
服务器托管后打开该路径（需要 HTTP，不能直接 `file://` 打开，因为使用了 ES 模块）。

界面提供：

- **选择搜索策略**：全搜索 / 同心螺旋 / 菱形细化，切换后重新编码即时对比。
- **逐帧浏览**：帧滑块、上一帧/下一帧、帧缩略条，方向键也可切换。
- **被搜索候选可视化**：选中块后，散点图按 `mvx/mvy` 摆放全部候选，颜色表示
  率失真代价，黄圈标出最终选择；下方表格列出候选的 SAD、向量比特与 RD 代价。
- **运动矢量与预测残差**：源帧、解码重建、预测帧、预测残差四视图；块检查器显示
  源块 / 预测块 / 残差 / 重建块四宫格，以及模式、MV、SAD、静止 SAD、比特分配。
- **异常由界面提示**：向量落在搜索边界、块改用帧内、向量 SAD 反而高于静止候选
  （说明是率失真而非最小像素差驱动）等都会在结果区顶部以告警条说明。
- **码流与完整性**：文件字节数、CRC、码率、头部十六进制转储。

界面里所有"解码重建"画面都来自浏览器内对 `.bmpp` 字节调用 `decodeVideo()`
的结果，不是原始帧的拷贝；若编码/解码抛错，界面显示错误而不是画面。

## 命令行（辅助）

命令行只用于生成/检查文件与无头跑对比，**不是**主要入口：

```bash
# 编码一个测试场景为真实文件
node scripts/cli.mjs encode pan out.bmpp --qp 24 --radius 12 --strategy spiral --frames 8

# 独立解码并校验 CRC
node scripts/cli.mjs decode out.bmpp --verify

# 查看头部
node scripts/cli.mjs info out.bmpp

# 三种策略的计算量与率失真对比
node scripts/cli.mjs bench occlusion --qp 24 --radius 10 --frames 8
```

`npm run encode/decode/bench` 是上述命令的别名。

## 三类测试场景

内置生成器 `src/core/scenarios.js` 提供与需求对应的素材：

| 场景 | 考察点 |
|------|--------|
| `pan` 平移纹理 | 稳定恢复已知整数位移；向量编码成本影响选择 |
| `occlusion` 遮挡显露 | 新显露区域无时间匹配，编码器应回退帧内 |
| `overshoot` 超范围运动 | 位移超搜索半径，向量被钳制到边界，解码仍一致且界面告警 |

## 代码结构

```
src/core/
  constants.js    格式常量（块大小、QP 表、zig-zag、范围限制）
  bitstream.js    MSB 优先读写、越界检查、Elias gamma
  transform.js    定点 8×8 DCT / IDCT、量化 / 反量化
  image.js        Frame 平面模型、SAD/SSD/PSNR、边界复制
  mvcode.js       运动矢量码字与编码成本
  coeff.js        系数块紧凑/原始两种熵编码
  blockcodec.js   预测、残差、变换、重建（编解码共用）
  search.js       三种搜索策略，率失真目标
  encoder.js      率失真模式决策 + 真实比特流写出
  decode.js       独立解码器（只依赖原语模块）
  container.js    文件头、CRC32
  scenarios.js    三类确定性测试序列
  bench.js        策略计算量/率失真对比
src/ui/           实验界面（HTML/CSS/JS，无框架）
scripts/cli.mjs   命令行辅助
scripts/serve.mjs 静态服务器
test/             Node 内置 test runner
docs/FORMAT.md    逐位格式规范
docs/UI.md        界面说明
```

## 设计要点

**参考帧契约**：搜索与预测只使用上一帧的重建图。原始帧仅用于形成残差和评估重建
误差，绝不进入参考缓冲。`test/reference-contract.test.js` 对此有专门断言。

**率失真，而非最小像素差**：搜索目标为 `J = SAD + λ·bits(mv)`，其中 `bits(mv)` 是
该矢量按 §4.1 真实编码所需的比特数，λ 由 QP 推导。`test/search.test.js` 构造了一个
"SAD 最优但比特更贵"的位移，验证加入比特成本后选择会改变。

**真实字节，不是箭头**：`encodeVideo` 产出 `Uint8Array`，`decodeVideo` 只接收字节。
测试断言 `decode(encode(x))` 与编码器内部重建逐像素相等，并断言磁盘文件可读回解码。

## 已知限制

- 整数像素运动，无亚像素插值。
- 无环路滤波、多参考帧、B 帧。
- 逐块独立决策，无全局率失真优化。
- 变换是普通定点 DCT，不是某个标准的整数变换。
