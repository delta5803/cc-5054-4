# BMPP-1 码流格式说明

BMPP-1 = **B**lock **M**otion **P**rediction **P**rofile **1**，是本项目为块运动预测实验
定义的私有格式。

> **非标准声明。** BMPP-1 不是 MPEG、H.264/AVC、H.265/HEVC、VP9、AV1 或任何其他编码
> 标准的一部分，也不声称与它们兼容或可互操作。整数变换、量化、熵编码都是为实验清晰性
> 重新设计的，只是恰好与常见做法相似。文件魔数 `BMPP` 是自定义标识。

参考实现：

- 编码器 `src/core/encoder.js`
- 解码器 `src/core/decode.js`（只依赖底层原语模块，不依赖编码器状态）
- 容器/头 `src/core/container.js`
- 变换 `src/core/transform.js`
- 系数熵编码 `src/core/coeff.js`
- 运动矢量码 `src/core/mvcode.js`

任何第三方实现只要遵循下面的逐位定义，就能解码本仓库产出的文件。

---

## 1. 约定

- 所有多字节整数为 **小端**。
- 所有比特字段为 **高位优先**（先写最高有效位）。
- 比特流起始于文件偏移 32 之后。
- 每个帧从**字节对齐**处开始；帧内比特字段连续排列，帧结束时补齐到字节。

## 2. 文件头（固定 32 字节）

| 偏移 | 长度 | 字段 | 说明 |
|-----:|-----:|------|------|
| 0 | 4 | magic | ASCII `BMPP` = `42 4D 50 50` |
| 4 | 1 | version | 固定 `1` |
| 5 | 1 | flags | bit0 = 源为灰度；其余位必须为 0 |
| 6 | 2 | reserved | 必须为 0 |
| 8 | 2 | width | 图像宽度，1..1920 |
| 10 | 2 | height | 图像高度，1..1920 |
| 12 | 1 | blockSize | 固定 `8` |
| 13 | 1 | components | `1`（灰度）或 `3`（R/G/B） |
| 14 | 1 | searchRadius | 编码所用搜索半径（信息性，0..255） |
| 15 | 1 | fps | 帧率（信息性，1..255） |
| 16 | 4 | frameCount | 帧数，1..4096 |
| 20 | 4 | payloadBits | payload 的**有效比特数**（不含末尾补零） |
| 24 | 4 | payloadCrc | payload 补齐到整字节后所有字节的 CRC-32 |
| 28 | 4 | totalSize | 整个文件字节数，必须等于实际长度 |

**CRC-32**：IEEE 802.3，反射多项式 `0xEDB88320`，初值 `0xFFFFFFFF`，输出取反。
计算范围是 `bytes[32 .. totalSize-1]`（即补齐后的 payload 字节）。

解码器**必须**校验：magic、version、保留位为 0、尺寸范围、blockSize=8、
components∈{1,3}、totalSize 与实际长度一致、`ceil(payloadBits/8) + 32 == totalSize`、
CRC 匹配。任一不符即拒绝解码，**不得**猜测或填补像素。

## 3. 帧

每帧：

```
align_to_byte()
1 bit    frameType      0 = 仅帧内（首帧必须为 0），1 = 允许帧间
6 bits   qp             0..51
块数据（按光栅顺序，逐行从左到右）
```

`frameType` 仅记录该帧是否允许帧间编码；每帧的参考**始终**是当前已解码的上一帧
重建，首帧没有参考。

## 4. 块

图像按 8×8 划分为 `ceil(width/8) × ceil(height/8)` 个块。边缘块在预测取样时对
参考图做**边界复制**；源图不存在的像素不参与计算。每个块：

```
1 bit        mode        0 = INTRA，1 = INTER
若 mode == 1：
   MV x      见 §4.1
   MV y      见 §4.1
若 mode == 0 且非首帧：MV 隐含为 (0,0)，不写入
对每个分量 c（0..components-1）：
   1 bit     present    1 = 后随一个系数块；0 = 该分量残差全为零
   若 present == 1：系数块（§5）
```

### 4.1 运动矢量

每个分量按 zig-zag 幅值映射后做 **Elias gamma** 编码：

```
map(v) = v <= 0 ? (-2*v + 1) : (2*v)
        v=0→1, -1→2, +1→3, -2→4, +2→5, ...
```

`map(v)` 必须是正整数。Elias gamma 编码正整数 `n`：

```
令 k = floor(log2(n))
写入 k 个 0，然后写入 n 的 (k+1) 位二进制
```

示例：

| v | map | gamma 比特 | 长度 |
|--:|----:|-----------|-----:|
| 0 | 1 | `1` | 1 |
| 1 | 2 | `010` | 3 |
| -1 | 3 | `011` | 3 |
| 5 | 10 | `0001010` | 7 |
| -5 | 11 | `0001011` | 7 |

`v` 范围 `-255..255`，`map` 不超过 511，gamma 码最长 < 18 位。

**这是运动矢量编码成本参与率失真选择的依据**：小矢量比特少，大矢量比特多，编码器
在搜索时用同一函数精确计价。

## 5. 系数块

对残差做 §7 的定点 DCT 与量化，得到 64 个量化电平 `levels[0..63]`（光栅顺序）。
按 **zig-zag** 顺序遍历（`src/core/constants.js` 的 `ZIGZAG`）。

先写 1 bit 形式标志：

### 5.1 紧凑形式（标志 = 0）

若满足：非零系数个数 ≤ 15，且任意两个非零系数之间的零游程 ≤ 15，则用紧凑形式：

```
1 bit      = 0
4 bits     pairCount    0..15
重复 pairCount 次：
   4 bits  run          当前非零系数前的零个数，0..15
   13 bits level        有符号，-4096..4095
```

遍历结束后剩余系数隐含为 0。

### 5.2 原始形式（标志 = 1）

否则（非零太多或游程太长）：

```
1 bit      = 1
重复 64 次（按 zig-zag 顺序）：
   13 bits level        有符号
```

编码器选择哪种形式是**确定性的**（满足条件即紧凑），因此解码器无需额外标志。

**13 位有符号范围** `-4096..4095` 覆盖 8 位残差经本变换后的最大系数（实测 ±2062），
保证量化后的电平值本身能精确传输（量化误差另计，见 §7.2）。

## 6. 运动补偿与重建

**参考图**是上一帧解码后的重建图，不是原始帧。这一条是整个实验成立的前提：
编码器在搜索和生成预测时使用的参考，必须与解码器持有的参考完全相同。

### 6.1 帧间预测

```
pred(y,x) = ref( clamp(y + mvy), clamp(x + mvx) )
clamp(k, limit) = max(0, min(limit-1, k))
```

### 6.2 帧内预测

DC 预测：取当前帧**已重建**的左列 8 个像素与上行 8 个像素的均值（四舍五入），
不存在的一侧不计入；两侧都不存在（左上角块）时用 128。

```
dc = round( sum(available neighbours) / count )
pred(y,x) = dc
```

### 6.3 重建

```
residual_levels = 解码得到的系数块
coef            = dequantize(residual_levels, qp)
residual        = idct(coef)
recon(y,x)      = clamp8( pred(y,x) + residual(y,x) )
clamp8(v)       = max(0, min(255, v))
```

重建**必须按块的光栅顺序进行**，因为帧内预测读取同帧已重建的邻居。

## 7. 变换与量化

### 7.1 定点 DCT

8×8 二维 DCT-II，基矩阵为（`src/core/transform.js`）：

```
basis[u][x] = round( 256 * c(u) * cos((2x+1) * u * PI / 16) )
c(0) = sqrt(1/8), c(u>0) = 1/2
```

前向：

```
tmp[u][x] = sum_y basis[u][y] * src[y][x]
coef[u][v] = round( sum_x tmp[u][x] * basis[v][x] / 65536 )
```

逆向：

```
tmp[a][x] = sum_u basis[u][a] * coef[u][x]
out[a][b] = round( sum_x tmp[a][x] * basis[x][b] / 65536 )
```

`round` 为**四舍五入、远离零**（`src/core/transform.js` 的 `divRound`）。

### 7.2 量化

```
step = QSTEP[qp]
dead = floor(step / 4)
if |c| < step - dead:  level = 0
else:                  q = floor((|c| + dead) / step);  level = sign(c) * q
```

逆量化：`coef = level * step`。

`QSTEP`（索引 0..51）：

```
1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 6, 6, 7, 8, 9, 10, 11,
13, 14, 16, 18, 20, 23, 25, 29, 32, 36, 40, 45, 51, 57, 64, 72, 81, 91,
102, 114, 128, 144, 161, 181, 203, 228, 256, 287, 323, 362
```

## 8. 颜色处理

BMPP-1 不对颜色做变换（没有 YCbCr）。编码几个分量就传几个分量：

- 灰度：1 个平面，直接存亮度。
- RGB：3 个平面 R/G/B，独立做运动补偿、DCT 与量化。
- 运动搜索**只用亮度平面（平面 0）**；所有分量各自编码残差。

因此 RGB 文件解码后直接是 R/G/B 值，无需逆颜色变换。

## 9. 解码流程（伪代码）

```
header = parse_and_validate(bytes)
reader = bit_reader(bytes, offset=32)
reference = null
for i in 0..frameCount-1:
    align_to_byte(reader)
    frameType = read(1)
    qp = read(6)
    frame = new_image(width, height, components)
    for each block (bx,by) in raster order:
        mode = read(1)
        if mode == INTER:
            assert reference != null
            mvx = read_mv(reader); mvy = read_mv(reader)
        for c in 0..components-1:
            present = read(1)
            if present: levels[c] = read_coeff_block(reader)
            else:       levels[c] = zeros
            pred = mode == INTER
                 ? motion_predict(reference, c, bx, by, mvx, mvy)
                 : dc_predict(frame, c, bx, by)
            reconstruct(frame, c, bx, by, pred, levels[c], qp)
    output(frame)
    reference = frame
```

## 10. 一致性与可验证性

- **逐像素可验证**：测试断言 `decode(encode(seq)).frames[i]` 与编码器内部重建
  `perFrame[i].recon` 完全相等（SSE=0）。见 `test/codec.test.js`、
  `test/reference-contract.test.js`。
- **拒绝坏数据**：magic/version/尺寸/CRC/截断错误均抛 `FormatError`，不会产出图像。
  见 `test/codec.test.js` 的负例。
- **真实文件**：`test/file-format.test.js` 把字节写到磁盘再读回解码。

## 11. 明确的非目标

- 不做亚像素运动补偿（矢量均为整数像素）。
- 不做环路滤波、多参考帧、B 帧、变换尺寸自适应。
- 不做颜色空间转换。
- `searchRadius`/`fps` 只是信息字段，解码不依赖它们。

这些取舍是为了让实验聚焦在「运动搜索策略 × 率失真 × 真实可解码字节」上。
