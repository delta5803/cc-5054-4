# 实验台子系统：独立参考解码、故障注入与失败缩减（src/lab）

本目录是 BMPP-1 主编解码器之外的**故障注入实验层**。主格式（`src/core`）保持整数像素、
单参考不变；这里的所有模块只复用底层原语（`BitReader/BitWriter`、Elias gamma、`Frame`、
边界复制），不被规范性编解码器引用，因此实验不会改变 BMPP-1 的逐位行为。

## 1. 模块一览

| 模块 | 职责 |
|------|------|
| `subpel.js` | 半像素双线性插值；正确路径只在最后舍入一次，故障路径逐轴提前舍入 |
| `refstore.js` | 带显式身份编号的参考帧仓库；两张纹理相同、身份不同的帧可共存 |
| `tile.js` | 实验分片码流 BMPT（magic `BMPT`），按显式 `refId` 命名参考；含暂挂/恢复解码 |
| `assembler.js` | 分片装配器：乱序到达、缺参考回报、暂挂预测、补参考后恢复 |
| `fixture.js` | 三类确定性夹具：双参考遮挡、首个运动块跨分片、等价向量 |
| `faults.js` | 两类故障注入与失败包（failure packet）构造 |
| `diagnose.js` | 按模式/参考编号/向量/残差/像素五个通道分别定位首个失配块 |
| `reducer.js` | delta-debugging 风格的失败样例缩减，缩减时保留原故障机制 |
| `replay.js` | 从失败包字段逐步重演误差传播，并承认等价向量的合法重建 |

无头报告入口：`node scripts/lab.mjs faults|reduce|replay|tiles|alias`。

## 2. BMPT 分片格式（16 字节头，小端）

```
偏移 长度 字段
0    4    magic "BMPT" = 42 4D 50 54
4    2    width
6    2    height
8    1    block size（固定 8）
9    1    tile index
10   1    tile total
11   1    本分片块数
12   4    payload 有效比特数
```

payload 中每个块：

```
1 bit  mode（0 帧内，1 帧间）
若帧间：gamma(refId+1)、gamma(hmvx 映射)、gamma(hmvy 映射)
        hmvx/hmvy 以半像素为单位（3 表示 1.5 像素），映射与 BMPP-1 的 MV 映射相同
64 个有符号 8 位残差（各 8 bit，-128..127）
```

帧内块是**上下文无关**的（DC 预测固定为 128），所以单个分片无需邻居或其他分片即可
解码验证。`test/lab/independent-parser.test.js` 内附一份只依据本文档写成的 Python 解析器，
与 JS 解析器交叉比对。

## 3. 缺参考时的契约

- `parseTile()` 只解析语法，**完全不访问参考仓库**：未知 `refId` 也能完整读出向量与残差。
- `decodeTile()` 遇到仓库中不存在的 `refId` 时把该块标记为 `suspended` 并记下原因，
  不抛错、不猜像素；同片内的帧内块和参考齐备的帧间块照常重建。
- `TileAssembler.ingest()` 返回 `{ missingRefs, suspended, decoded }` 并累积缺参考报告；
  `viewTile()` 让测试端在其他分片未到齐时独立核验已收到分片的真实写出字段。
- 参考通过独立通道注册（`registerReference`）后，`resumePending()` 用**块自身传输的
  语法**重建暂挂预测；恢复结果与“参考一开始就在场”的直接解码逐像素相等（有测试断言）。

## 4. 两类像素误差相近、机制不同的故障

夹具 `buildTwinRefFixture()` 构造两张纹理平面相同但身份不同的参考帧 R0/R1，各放一个
薄遮挡条，恰好跨过目标运动块（默认块 (1,1)）的左右边界；遮挡物灰度取该块实际采样窗
纹理均值附近，使错误参考的误差与单级舍入误差同量级（默认 SSE 14 对 22，4 倍带内）。

| 故障 | 做法 | 写出的向量 | 写出的参考编号 | 写出的残差 | 像素 |
|------|------|-----------|---------------|-----------|------|
| `wrong-reference` | 帧间块改取 R1，其余不动 | 不变 | **改变** | 不变 | 失配 |
| `early-rounding` | 双线性插值逐轴提前舍入 | 不变 | 不变 | 不变 | 失配 |

提前舍入只有在两个轴都带小数（半像素向量两个分量均为奇数）时才可能与正确路径分歧；
缩减器把这一点作为该故障的存活条件。

`diagnoseBlocks()` 按光栅顺序分别报告每个通道的首个失配块：错误参考故障由 `refId`
通道独家解释，提前舍入故障的四个写出通道全部干净、只有像素通道有签名——因此仅比较
SSE 无法区分二者，必须读真实写出的向量、参考编号和残差。

## 5. 失败包与调试重演

`applyFault()` 返回的失败包自带重演所需全部字段：

```
written        实际写出的 refId / hmvx / hmvy / residual
correctSyntax  正确语法（用于通道比对）
channels       四个通道是否改变的布尔签名
predictions    正确与故障 8×8 预测块
firstMismatch  首个失配像素的块内坐标与两侧值
sse / sad / differingPixels / detail
```

`replayPacket()` 只凭这些字段（加参考仓库）按 `reference → vector → interpolate →
compare-pixels → apply-residual` 五步重演，逐像素记录误差如何出现，不依赖任何编码器
状态。`isEquivalentReconstruction()` 承认**等价向量**：元组不同但两个参考都在仓库中、
重建像素与目标完全一致时判为合法；命名缺失参考则返回非法而不是抛异常。

## 6. 失败样例缩减

`reduceFaultSample(fault)` 按从小到大的几何（16×16 起）与位移网格贪心尝试，接受条件是
故障专属谓词：

- 错误参考：仍有像素失配，且 `refIdChanged=true`、向量通道不变；
- 提前舍入：向量保持奇/奇半像素分量、仍有像素失配，且只有插值器签名。

被缩减到“恰好通过”的样例会被拒绝；返回值包含每次尝试与 `preserved` 标志，测试断言
所有被接受尝试的机制标识与首个失配像素始终存在。

## 7. 等价向量与下一帧漂移

`buildAliasFixture()` 让两条候选向量在当前块得到**字节一致的当前像素**（各自命中一张
参考帧上同值、不同位置的平坦区域，区域覆盖整条半像素取样足迹）：

- `correct-relation`：从 R0 取数，参考链 R0 → id 2 合法；
- `broken-relation`：从 R1 取数，当前帧巧合通过，但到 id 2 的参考链断裂。

下一帧在目标块内引入一个已知变化像素，并把两种预测的**残差**一并构造：合法链对当前
重建做零向量预测，残差能量小；断裂链若直接回退到 R1，落在纹理区，残差能量高出数个
数量级。`classifyAlias()` 据此给出两种结论：

- `legal-alternative`：码流合法、选择不同但参考关系有效；
- `coincidental-pass-then-drift`：当前帧巧合通过，下一帧残差暴露漂移。

`replayAliasPropagation()` 回报漂移起点（首个变化像素坐标与新旧值）及两条链的残差能量。

## 8. 首个运动块跨分片样流

`buildSplitTileFixture()` 产出三个分片：分片 0 是参考帧（全帧内块），分片 1/2 是引用
`refId=0` 的帧间帧，其中光栅顺序的**第一个运动块被单独打进分片 2**。装配器先收到
分片 1、2 时全部帧间块暂挂、帧内块仍可独立验证；参考分片到达注册后逐块恢复，恢复
画面与参考在场时的直接解码逐像素相等（见 `test/lab/tile-assembler.test.js`）。
