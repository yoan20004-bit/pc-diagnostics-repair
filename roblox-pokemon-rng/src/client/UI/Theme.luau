--!nonstrict
--[[
	Theme
	Colours, type scale and the small decorators every panel uses.

	Rarity colours live in the shared Rarity module as RGB triples so the server
	can use them too (for the world pillars and buddy orbs). Theme is where they
	become Color3.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("PokeRNG")

local Rarity = require(Shared.Rarity)
local Species = require(Shared.Species)

local Create = require(script.Parent.Create)

local Theme = {}

Theme.color = {
	backdrop = Color3.fromRGB(10, 12, 18),
	panel = Color3.fromRGB(22, 25, 35),
	panelAlt = Color3.fromRGB(30, 34, 47),
	panelHi = Color3.fromRGB(40, 45, 62),
	stroke = Color3.fromRGB(58, 64, 84),
	text = Color3.fromRGB(238, 241, 250),
	subtext = Color3.fromRGB(154, 162, 182),
	accent = Color3.fromRGB(96, 165, 250),
	accentDark = Color3.fromRGB(56, 110, 190),
	success = Color3.fromRGB(74, 205, 130),
	warning = Color3.fromRGB(246, 190, 70),
	error = Color3.fromRGB(238, 92, 92),
	coin = Color3.fromRGB(250, 204, 84),
	xp = Color3.fromRGB(126, 214, 160),
}

Theme.font = {
	heading = Enum.Font.GothamBold,
	body = Enum.Font.Gotham,
	mono = Enum.Font.Code,
}

function Theme.rarityColor(tierId: string): Color3
	local tier = Rarity.byId[tierId]
	if not tier then
		return Theme.color.subtext
	end
	return Color3.fromRGB(tier.color[1], tier.color[2], tier.color[3])
end

function Theme.rarityGlow(tierId: string): Color3
	local tier = Rarity.byId[tierId]
	if not tier then
		return Theme.color.text
	end
	return Color3.fromRGB(tier.glow[1], tier.glow[2], tier.glow[3])
end

function Theme.speciesColor(speciesId: number): Color3
	local species = Species.byId[speciesId]
	if not species then
		return Theme.color.subtext
	end
	return Theme.rarityColor(species.tier)
end

--------------------------------------------------------------------------------
-- Decorators
--------------------------------------------------------------------------------

function Theme.corner(radius: number?)
	return Create("UICorner", { CornerRadius = UDim.new(0, radius or 8) })
end

function Theme.stroke(color: Color3?, thickness: number?, transparency: number?)
	return Create("UIStroke", {
		Color = color or Theme.color.stroke,
		Thickness = thickness or 1,
		Transparency = transparency or 0,
		ApplyStrokeMode = Enum.ApplyStrokeMode.Border,
	})
end

function Theme.padding(all: number?, extra: { [string]: number }?)
	local value = all or 8
	local props = {
		PaddingTop = UDim.new(0, value),
		PaddingBottom = UDim.new(0, value),
		PaddingLeft = UDim.new(0, value),
		PaddingRight = UDim.new(0, value),
	}
	if extra then
		for key, amount in extra do
			props[key] = UDim.new(0, amount)
		end
	end
	return Create("UIPadding", props)
end

function Theme.listLayout(padding: number?, direction: Enum.FillDirection?, align: Enum.HorizontalAlignment?)
	return Create("UIListLayout", {
		Padding = UDim.new(0, padding or 6),
		FillDirection = direction or Enum.FillDirection.Vertical,
		SortOrder = Enum.SortOrder.LayoutOrder,
		HorizontalAlignment = align or Enum.HorizontalAlignment.Left,
		VerticalAlignment = Enum.VerticalAlignment.Top,
	})
end

function Theme.gridLayout(cellSize: UDim2, padding: number?)
	return Create("UIGridLayout", {
		CellSize = cellSize,
		CellPadding = UDim2.fromOffset(padding or 8, padding or 8),
		SortOrder = Enum.SortOrder.LayoutOrder,
		HorizontalAlignment = Enum.HorizontalAlignment.Left,
	})
end

--[[
	A vertical two-stop gradient, used to give flat panels a bit of depth.
]]
function Theme.gradient(top: Color3, bottom: Color3, rotation: number?)
	return Create("UIGradient", {
		Color = ColorSequence.new(top, bottom),
		Rotation = rotation or 90,
	})
end

--------------------------------------------------------------------------------
-- Common widgets
--------------------------------------------------------------------------------

function Theme.label(props: { [any]: any })
	local merged = {
		BackgroundTransparency = 1,
		Font = Theme.font.body,
		TextColor3 = Theme.color.text,
		TextSize = 14,
		TextXAlignment = Enum.TextXAlignment.Left,
		TextYAlignment = Enum.TextYAlignment.Center,
		RichText = true,
	}
	for key, value in props do
		merged[key] = value
	end
	return Create("TextLabel", merged)
end

function Theme.heading(text: string, size: number?)
	return Theme.label({
		Text = text,
		Font = Theme.font.heading,
		TextSize = size or 18,
		Size = UDim2.new(1, 0, 0, (size or 18) + 8),
	})
end

--[[
	A button with hover and press feedback. `onClick` is optional so the same
	helper can build a purely decorative chip.
]]
function Theme.button(props: { [any]: any }, onClick: (() -> ())?)
	local fill = props.BackgroundColor3 or Theme.color.panelHi

	local merged = {
		BackgroundColor3 = fill,
		BorderSizePixel = 0,
		AutoButtonColor = false,
		Font = Theme.font.heading,
		TextColor3 = Theme.color.text,
		TextSize = 14,
		Text = props.Text or "",
	}
	for key, value in props do
		merged[key] = value
	end

	local button = Create("TextButton", merged)
	Theme.corner(8).Parent = button
	Theme.stroke(Theme.color.stroke, 1, 0.4).Parent = button

	local TweenService = game:GetService("TweenService")
	local info = TweenInfo.new(0.12, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)

	button.MouseEnter:Connect(function()
		TweenService:Create(button, info, { BackgroundColor3 = fill:Lerp(Color3.new(1, 1, 1), 0.14) }):Play()
	end)
	button.MouseLeave:Connect(function()
		TweenService:Create(button, info, { BackgroundColor3 = fill }):Play()
	end)
	button.MouseButton1Down:Connect(function()
		TweenService:Create(button, info, { BackgroundColor3 = fill:Lerp(Color3.new(0, 0, 0), 0.2) }):Play()
	end)
	button.MouseButton1Up:Connect(function()
		TweenService:Create(button, info, { BackgroundColor3 = fill:Lerp(Color3.new(1, 1, 1), 0.14) }):Play()
	end)

	if onClick then
		button.Activated:Connect(onClick)
	end

	return button
end

--[[
	A labelled progress bar. Returns the container plus a setter, so callers
	don't have to reach into the instance tree to update it.
]]
function Theme.bar(fillColor: Color3, height: number?)
	local track = Create("Frame", {
		BackgroundColor3 = Theme.color.backdrop,
		BorderSizePixel = 0,
		Size = UDim2.new(1, 0, 0, height or 8),
	})
	Theme.corner(6).Parent = track

	local fill = Create("Frame", {
		BackgroundColor3 = fillColor,
		BorderSizePixel = 0,
		Size = UDim2.fromScale(0, 1),
		Parent = track,
	})
	Theme.corner(6).Parent = fill

	local function set(alpha: number)
		fill.Size = UDim2.fromScale(math.clamp(alpha, 0, 1), 1)
	end

	return track, set, fill
end

--[[
	Roblox scrolling frames need their CanvasSize maintained by hand whenever
	their contents change. This wires that up once.
]]
function Theme.autoCanvas(scroller: ScrollingFrame, layout: Instance)
	local function refresh()
		if layout:IsA("UIGridLayout") or layout:IsA("UIListLayout") then
			scroller.CanvasSize = UDim2.new(0, 0, 0, layout.AbsoluteContentSize.Y + 12)
		end
	end
	layout:GetPropertyChangedSignal("AbsoluteContentSize"):Connect(refresh)
	refresh()
end

return Theme
