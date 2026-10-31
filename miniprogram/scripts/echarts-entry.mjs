/** ECharts按需入口：仅折线图、坐标网格、提示框与Canvas渲染器；构建时打包进charts分包。 */
import { use, init, setPlatformAPI } from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

use([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

export { init, setPlatformAPI };
